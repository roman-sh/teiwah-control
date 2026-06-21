import { Injectable } from '@nestjs/common'
import {
  Freemius,
  idToNumber,
  type EventEntity,
  type PurchaseInfo,
  type WebhookEvent
} from '@freemius/sdk'
import { ReconciliationQueueService } from '../bullmq/reconciliation-queue.service'
import { DbService } from '../db/db.service'

/** Thrown when Freemius returns an HTTP error the job should retry (e.g. 503). */
export class FreemiusApiError extends Error {
  constructor(
    readonly freemiusUserId: string,
    readonly status: number
  ) {
    super(`Freemius API error ${status} for user ${freemiusUserId}`)
    this.name = 'FreemiusApiError'
  }
}

/** Thrown when a license exists but Freemius returned no numeric quota. */
export class FreemiusLicenseQuotaMissingError extends Error {
  constructor(readonly licenseId: string) {
    super(`Freemius license has no quota: ${licenseId}`)
    this.name = 'FreemiusLicenseQuotaMissingError'
  }
}

/**
 * Freemius webhook body plus `user_id` on the envelope (the SDK type omits it).
 */
export type FreemiusWebhookPayload = WebhookEvent & Pick<EventEntity, 'user_id'>

@Injectable()
export class FreemiusService {
  private readonly freemius: Freemius

  /** Wires the Freemius SDK client and Nest dependencies. */
  constructor(
    private readonly db: DbService,
    private readonly reconciliationQueue: ReconciliationQueueService
  ) {
    this.freemius = new Freemius({
      productId: env.FS_PRODUCT_ID,
      apiKey: env.FS_API_KEY,
      secretKey: env.FS_SECRET_KEY,
      publicKey: env.FS_PUBLIC_KEY
    })
  }

  /**
   * How many concurrent sessions this Freemius user is allowed to run right now.
   *
   * First we call the SDK's retrievePurchases. Teiwah expects one active license
   * per user, so this normally returns a single purchase; we take the first and
   * derive quota from it. That covers the usual path after signup, upgrade, or
   * cancel.
   *
   * When retrievePurchases returns an empty array, we cannot tell why from the
   * SDK alone: the user may have no active license, the user may be gone from
   * Freemius, or Freemius may have failed and the SDK collapsed the error into
   * []. So we make a second request with the raw API client — status only — on
   * GET …/users/{id}/licenses.json?type=active:
   *   - 404 → user gone → quota 0
   *   - 200 → user exists, SDK [] is real (no active license) → quota 0
   *   - anything else → throw FreemiusApiError; BullMQ retries (API error)
   *
   * @param freemiusUserId - Freemius user id from webhooks or our users row.
   * @returns Effective session quota (0 if expired or no active license).
   * @throws {FreemiusApiError} When Freemius returns a retryable HTTP error.
   * @throws {FreemiusLicenseQuotaMissingError} When quota is null on a valid license.
   */
  async getEntitlement(freemiusUserId: string): Promise<number> {
    const purchases = await this.freemius.purchase.retrievePurchases(freemiusUserId)

    switch (purchases.length) {
      case 0:
        return this.resolveEntitlementWhenNoPurchases(freemiusUserId)
      default:
        return this.effectiveQuotaFromPurchase(purchases[0])
    }
  }

  /**
   * Handles incoming Freemius webhooks.
   *
   * We do not verify a signature in v1. The body is only a notification that
   * something changed — the worker re-fetches entitlement from Freemius when the
   * delayed job runs, instead of trusting quota or expiration from the payload.
   *
   * @param payload - Parsed webhook body from the controller.
   */
  async handleLicenseWebhook(payload: FreemiusWebhookPayload): Promise<void> {
    // Subscribe to these in the Freemius dashboard. plan.changed is covered by
    // license.updated. Everything else (other license.*, payments, etc.) is ignored.
    switch (payload.type) {
      case 'license.deleted':
      case 'license.updated':
      case 'license.created':
      case 'license.cancelled':
      case 'license.expired':
      case 'license.extended':
      case 'license.shortened':
        await this.reconcileLicenseWebhook(payload)
        break
      default:
        log.info(
          { eventId: payload.id, type: payload.type },
          payload.type.startsWith('license.')
            ? 'Freemius license webhook ignored — not a reconciliation trigger'
            : 'Freemius webhook ignored — not a license event'
        )
    }
  }

  /**
   * Runs bind + enqueue for a license webhook that should trigger reconciliation.
   *
   * @param payload - A license.* event from {@link handleLicenseWebhook}.
   */
  private async reconcileLicenseWebhook(payload: FreemiusWebhookPayload): Promise<void> {
    const freemiusUserId = payload.user_id ? String(payload.user_id) : undefined
    if (!freemiusUserId) {
      log.warn(
        { eventId: payload.id, type: payload.type },
        'Freemius license webhook with no user id — cannot enqueue reconciliation'
      )
      return
    }

    log.info(
      { eventId: payload.id, type: payload.type, freemiusUserId },
      'Freemius license webhook processing'
    )

    // Link Freemius user to our users row if not already. Needs email in payload;
    // delete and some dashboard events omit it, so binding may no-op until later.
    await this.bindFreemiusUser(payload)

    await this.reconciliationQueue.enqueueReconciliation({ freemiusUserId })
  }

  /**
   * Derives effective quota from an SDK purchase (retrievePurchases result).
   *
   * Checks expiration before quota. Expired licenses return 0 even if quota is
   * still set in Freemius.
   *
   * @param purchase - One active purchase from retrievePurchases.
   * @returns Effective session quota.
   * @throws {FreemiusLicenseQuotaMissingError} When quota is null or undefined.
   */
  private effectiveQuotaFromPurchase(purchase: PurchaseInfo): number {
    // Expired license → user may not run any sessions, regardless of quota field.
    if (purchase.expiration && purchase.expiration < new Date()) return 0
    // Teiwah plans always have a number. Freemius uses null for unlimited — not valid here.
    if (purchase.quota === null || purchase.quota === undefined) {
      throw new FreemiusLicenseQuotaMissingError(purchase.licenseId)
    }
    return purchase.quota
  }

  /**
   * Fallback when retrievePurchases returned an empty array.
   *
   * SDK [] can mean three things; unstable status disambiguates (no body read):
   *   - 404 — user not found → quota 0
   *   - 200 — user exists, no active license → quota 0
   *   - other — API error → throw, BullMQ retries
   *
   * @param freemiusUserId - Freemius user id to look up.
   * @returns 0 when the user is gone or has no active license.
   * @throws {FreemiusApiError} When Freemius returns a status other than 404 or 200.
   */
  private async resolveEntitlementWhenNoPurchases(freemiusUserId: string): Promise<number> {
    const { response } = await this.freemius.api.__unstable_ApiClient.GET(
      '/products/{product_id}/users/{user_id}/licenses.json',
      {
        params: {
          path: {
            product_id: idToNumber(env.FS_PRODUCT_ID),
            user_id: idToNumber(freemiusUserId)
          },
          query: { type: 'active' }
        }
      }
    )

    switch (response.status) {
      case 404:
      case 200:
        return 0
      default:
        throw new FreemiusApiError(freemiusUserId, response.status)
    }
  }

  /**
   * Store freemiusUserId on our users row so future webhooks can find the user.
   *
   * Clerk creates the row at sign-up (email only). Freemius has its own user id.
   * On the first license event we match by email, then freemiusUserId becomes the
   * permanent key. We never create users here — only Clerk does.
   *
   * @param payload - License webhook; must include user_id, and email on first bind.
   */
  private async bindFreemiusUser(payload: FreemiusWebhookPayload): Promise<void> {
    const freemiusUserId = payload.user_id ? String(payload.user_id) : undefined
    if (!freemiusUserId) {
      log.warn(
        { eventId: payload.id, type: payload.type },
        'Freemius license event with no user id — cannot bind'
      )
      return
    }

    log.info({ eventId: payload.id, freemiusUserId }, 'Freemius bind attempt')

    // Already linked — nothing to do.
    const alreadyBound = await this.db.user.findUnique({
      where: { freemiusUserId }
    })
    if (alreadyBound) {
      log.info(
        { eventId: payload.id, freemiusUserId, clerkUserId: alreadyBound.id },
        'Freemius bind skipped — already bound'
      )
      return
    }

    // First-time bind: match Clerk user by email from the webhook payload.
    const email =
      payload.objects && 'user' in payload.objects
        ? payload.objects.user?.email
        : undefined
    if (!email) {
      log.debug(
        { eventId: payload.id, freemiusUserId, type: payload.type },
        'Freemius license event with no user email — cannot bind'
      )
      return
    }

    log.info({ eventId: payload.id, freemiusUserId, email }, 'Freemius bind — matching email')

    const user = await this.db.user.findUnique({ where: { email } })
    if (!user) {
      log.warn(
        { eventId: payload.id, freemiusUserId, email, type: payload.type },
        'No users row for Freemius email — skipped bind'
      )
      return
    }

    // Same email already tied to a different Freemius account — do not overwrite.
    if (user.freemiusUserId && user.freemiusUserId !== freemiusUserId) {
      log.warn(
        { eventId: payload.id, clerkUserId: user.id, email, freemiusUserId },
        'users row already bound to a different Freemius user — skipped'
      )
      return
    }

    await this.db.user.update({
      where: { id: user.id },
      data: { freemiusUserId }
    })

    log.info(
      { eventId: payload.id, clerkUserId: user.id, freemiusUserId, email },
      'Freemius user bound'
    )
  }
}
