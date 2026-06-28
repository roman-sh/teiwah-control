import { HttpStatus, Injectable } from '@nestjs/common'
import { DbService } from '../db/db.service'
import { FreemiusApiError, FreemiusService } from '../billing/freemius.service'
import { ClerkService } from '../users/clerk.service'
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
    private readonly clerkService: ClerkService,
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
      log.warn({ userId }, 'Provision gate blocked: user row not found')
      throw new ProvisionGateBlockedException(
        'User not found',
        HttpStatus.NOT_FOUND
      )
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
      log.info(
        { userId, used: dailyCreated, limit: user.dailyProvisionLimit },
        'Provision gate blocked: daily limit'
      )
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
      log.info(
        { userId, used: activeCount, limit: user.maxConcurrentSessions },
        'Provision gate blocked: concurrent cap'
      )
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
    //                            (createUpgradeCheckout / POST /billing/checkout).
    //
    // On overlay success the frontend retries POST /sessions; the gate re-fetches
    // entitlement live so the retry sees the fresh quota.

    // Bind on demand (BILLING.md §3/§4.3). If we have no freemiusUserId yet, derive
    // it server-side and persist it. A miss means Freemius has no account for this
    // email yet → genuine new purchase, so emit the new-purchase 402.
    let freemiusUserId = user.freemiusUserId
    if (!freemiusUserId) {
      freemiusUserId = await this.bindFreemiusUser(userId)
      if (!freemiusUserId) {
        log.info(
          { userId },
          'Provision gate blocked: subscription required (new purchase)'
        )
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
    }

    // Read the user's active license. One license per user, so this settles the
    // whole branch in a single lookup: a present license is active and carries
    // the quota we enforce; a null means that single license is expired (the
    // renewal case) — there's no separate "is it active or expired?" call.
    let entitlement: { quota: number } | null
    try {
      entitlement =
        await this.freemiusService.getActiveEntitlement(freemiusUserId)
    } catch (error) {
      if (error instanceof FreemiusApiError) {
        // Freemius API down — can't verify entitlement; don't provision blind.
        log.warn(
          { userId, freemiusUserId },
          'Provision gate blocked: billing unavailable'
        )
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

    // No active license, but the user IS bound to a Freemius account (we're past
    // the bind step) — a returning user whose license lapsed or whose no-payment
    // trial ended. They must subscribe, and must NOT be offered a second free
    // trial: we renew their existing (expired) license, preserving the
    // one-user↔one-license invariant (BILLING.md §1). The frontend gets
    // `settings`, the same branch the upgrade path uses.
    if (!entitlement) {
      const checkout =
        await this.freemiusService.createRenewalCheckout(freemiusUserId)
      log.info(
        { userId },
        'Provision gate blocked: subscription required (no active entitlement)'
      )
      throw new ProvisionGateBlockedException(
        {
          error: 'quota_exceeded',
          message: 'Subscribe to create a session.',
          quota: 0,
          used: activeCount,
          checkout
        },
        HttpStatus.PAYMENT_REQUIRED
      )
    }

    // Active license — enforce its quota.
    const quota = entitlement.quota

    // Room under paid quota — gate passes, caller may provision.
    if (activeCount < quota) {
      log.debug({ userId, quota, used: activeCount }, 'Provision gate passed')
      return
    }

    // At or over paid quota — license-scoped checkout to add one more seat.
    const checkout = await this.buildUpgradeCheckout(userId, quota)

    log.info(
      { userId, quota, used: activeCount },
      'Provision gate blocked: upgrade required'
    )
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
   * Bind freemiusUserId on a user's first create (BILLING.md §3/§4.3).
   *
   * Server-derived, zero client trust: the email comes from Clerk (live, not our
   * possibly-stale DB and not the request), then Freemius is looked up by that
   * email. A hit is persisted onto the users row and returned; a null means
   * Freemius has no account yet, so the caller treats it as a new purchase. This
   * runs inside the gate, so it self-heals — a failed bind is retried on the next
   * create rather than leaving the user stuck unbound.
   *
   * @param userId - The authenticated Clerk user id (our internal user id).
   * @returns The bound freemiusUserId, or null if no Freemius account exists yet.
   */
  private async bindFreemiusUser(userId: string): Promise<string | null> {
    const email = await this.clerkService.getPrimaryEmail(userId)
    if (!email) {
      log.warn(
        { userId },
        'Provision bind skipped — no primary email from Clerk'
      )
      return null
    }

    const freemiusUserId =
      await this.freemiusService.findFreemiusUserIdByEmail(email)
    if (!freemiusUserId) {
      log.info(
        { userId, email },
        'Provision bind — no Freemius account for email yet (new purchase)'
      )
      return null
    }

    await this.db.user.update({
      where: { id: userId },
      data: { freemiusUserId }
    })
    log.info(
      { userId, freemiusUserId, email },
      'Freemius user bound at provision gate'
    )
    return freemiusUserId
  }

  /**
   * License-scoped checkout for the at-capacity 402 path — authorize one more
   * paid seat (current Freemius quota + 1). Only called when quota > 0.
   */
  private async buildUpgradeCheckout(userId: string, quota: number) {
    return this.freemiusService.createUpgradeCheckout(userId, {
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
