import { HttpStatus, Injectable } from '@nestjs/common'
import { DbService } from '../db/db.service'
import {
  FreemiusApiError,
  FreemiusService
} from '../billing/freemius.service'
import { SessionsService } from '../sessions/sessions.service'
import { ProvisionGateBlockedException } from './provision-gate.exception'

const PROVISION_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * Quota enforcement — the upward arm of BILLING.md §4.
 *
 * This is the only place that needs BOTH the billing read (FreemiusService) and
 * the session lifecycle (SessionsService): the gate runs the live entitlement
 * check, then delegates the actual create to SessionsService. Keeping it here
 * keeps SessionsService free of any billing dependency (pure k8s/Zuplo/DB).
 */
@Injectable()
export class ProvisionService {
  constructor(
    private readonly db: DbService,
    private readonly freemiusService: FreemiusService,
    private readonly sessionsService: SessionsService
  ) {}

  /**
   * Provision gate for POST /sessions — check or throw, no return value on success.
   *
   * Runs three checks in order. If all pass, returns normally and the caller
   * continues to k8s/Zuplo/DB. If any check fails, throws
   * ProvisionGateBlockedException and provision never starts.
   *
   *   1. Daily rate limit (our abuse cap) → 429
   *   2. Concurrent active cap (our abuse cap) → 429
   *   3. Freemius paid quota (what they paid for) → 402 + checkout
   */
  async assertProvisionGate(userId: string): Promise<void> {
    const user = await this.db.user.findUnique({ where: { id: userId } })
    if (!user) {
      throw new ProvisionGateBlockedException('User not found', HttpStatus.NOT_FOUND)
    }

    const since = new Date(Date.now() - PROVISION_WINDOW_MS)
    const [dailyCreated, activeCount] = await Promise.all([
      // Includes soft-deleted rows — a create still counts toward the daily cap.
      this.db.session.count({
        where: { userId, createdAt: { gte: since } }
      }),
      this.db.activeSession.count({ where: { userId } })
    ])

    // 1. Daily rate limit — platform abuse cap, not billing.
    if (dailyCreated >= user.dailyProvisionLimit) {
      throw new ProvisionGateBlockedException(
        {
          error: 'daily_provision_limit_exceeded',
          message: `You can create at most ${user.dailyProvisionLimit} sessions per 24 hours.`,
          limit: user.dailyProvisionLimit,
          used: dailyCreated
        },
        HttpStatus.TOO_MANY_REQUESTS
      )
    }

    // 2. Concurrent cap — platform abuse cap, not billing.
    if (activeCount >= user.maxConcurrentSessions) {
      throw new ProvisionGateBlockedException(
        {
          error: 'concurrent_session_limit_exceeded',
          message: `Maximum of ${user.maxConcurrentSessions} active sessions reached. Contact support for a quota increase.`,
          limit: user.maxConcurrentSessions,
          used: activeCount
        },
        HttpStatus.TOO_MANY_REQUESTS
      )
    }

    // 3. Freemius entitlement — what they paid for (separate from abuse caps above).
    //
    // A 402 means "you need billing action before we provision." The response always
    // includes a `checkout` object. Frontend branches on whether `checkout.settings`
    // is present (see BILLING.md §4.3 / §7):
    //
    //   checkout: {}           → new purchase — frontend opens the Freemius overlay
    //                            itself (Clerk email + readonly_user). No backend
    //                            pre-step; nothing to generate here.
  //   checkout: { settings } → upgrade — backend-generated license-scoped checkout
  //                            (createLicenseScopedCheckout / POST /billing/checkout).
    //
    // On overlay success the frontend retries POST /sessions; the gate re-fetches
    // entitlement live so the retry sees the fresh quota.

    // Not bound to Freemius yet (Clerk user exists, no license event matched email).
    if (!user.freemiusUserId) {
      throw new ProvisionGateBlockedException(
        {
          error: 'quota_exceeded',
          message: 'Subscribe to create a session.',
          quota: 0,
          used: activeCount,
          checkout: {} // new-purchase path — frontend opens overlay with Clerk email
        },
        HttpStatus.PAYMENT_REQUIRED
      )
    }

    // Ask Freemius how many concurrent sessions this user may run.
    let quota: number
    try {
      quota = await this.freemiusService.getEntitlement(user.freemiusUserId)
    } catch (error) {
      if (error instanceof FreemiusApiError) {
        // Freemius API down — can't verify entitlement; don't provision blind.
        throw new ProvisionGateBlockedException(
          {
            error: 'billing_unavailable',
            message:
              'Unable to verify your subscription right now. Please try again shortly.'
          },
          HttpStatus.SERVICE_UNAVAILABLE
        )
      }
      throw error
    }

    // Room under paid quota — gate passes, caller may provision.
    if (activeCount < quota) return

    // At or over paid quota — 402 with license-scoped checkout settings when possible.
    const checkout = await this.buildUpgradeCheckout(userId, quota)

    throw new ProvisionGateBlockedException(
      {
        error: 'quota_exceeded',
        message: 'Subscribe or upgrade to create another session.',
        quota,
        used: activeCount,
        checkout
      },
      HttpStatus.PAYMENT_REQUIRED
    )
  }

  /**
   * License-scoped checkout for the 402 path — authorize one more paid seat
   * (current Freemius quota + 1). Same for create and revive: re-subscribe
   * after lapse (0 + 1), at-capacity upgrade (1 + 1), etc.
   */
  private async buildUpgradeCheckout(userId: string, quota: number) {
    return this.freemiusService.createLicenseScopedCheckout(userId, {
      quota: quota + 1
    })
  }

  /**
   * Gated create for POST /sessions: run the provision gate, then delegate the
   * actual provisioning (k8s → Zuplo → DB) to SessionsService.
   */
  async createSession(userId: string) {
    await this.assertProvisionGate(userId)
    return this.sessionsService.createSession(userId)
  }
}
