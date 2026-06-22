import { HttpException, HttpStatus, Injectable } from '@nestjs/common'
import {
  Freemius,
  idToNumber,
  idToString,
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
   * Live billing state for this Freemius user: effective quota plus trial flag.
   *
   * One retrievePurchases call drives both the enforcement read (quota) and the
   * display read (isTrial/trialEndsAt). Teiwah expects one active license per
   * user, so this normally returns a single purchase; we take the first.
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
   * The license carries no trial flag, so trial is inferred as a valid (active,
   * non-expired) license with no subscription — a no-payment trial has a license
   * but no subscription yet (BILLING.md §7/§10). `trialEndsAt` is the license
   * expiration. An empty/expired result is never a trial.
   *
   * @param freemiusUserId - Freemius user id from webhooks or our users row.
   * @returns Effective quota and trial state.
   * @throws {FreemiusApiError} When Freemius returns a retryable HTTP error.
   * @throws {FreemiusLicenseQuotaMissingError} When quota is null on a valid license.
   */
  async getBillingSummary(freemiusUserId: string): Promise<{
    quota: number
    isTrial: boolean
    trialEndsAt: Date | null
  }> {
    const purchases =
      await this.freemius.purchase.retrievePurchases(freemiusUserId)

    switch (purchases.length) {
      case 0: {
        // Empty — confirm it's a real "no license", not a swallowed Freemius
        // outage (throws if it can't confirm). No license → quota 0, no trial.
        await this.assertNoActiveLicense(freemiusUserId)
        return { quota: 0, isTrial: false, trialEndsAt: null }
      }
      default: {
        // One active license expected — take the first. Quota comes from the
        // license; trial is inferred as a valid (active) license with no
        // subscription, with the license expiration as its end date.
        const purchase = purchases[0]
        const quota = this.effectiveQuotaFromPurchase(purchase)
        const isTrial = purchase.isActive && !purchase.isSubscription()
        return {
          quota,
          isTrial,
          trialEndsAt: isTrial ? purchase.expiration : null
        }
      }
    }
  }

  /**
   * Effective concurrent-session quota — the enforcement read for the provision
   * gate and the reconciler. Thin wrapper over {@link getBillingSummary}; trial
   * fields are ignored here.
   *
   * @param freemiusUserId - Freemius user id from webhooks or our users row.
   * @returns Effective session quota (0 if expired or no active license).
   * @throws {FreemiusApiError} When Freemius returns a retryable HTTP error.
   * @throws {FreemiusLicenseQuotaMissingError} When quota is null on a valid license.
   */
  async getEntitlement(freemiusUserId: string): Promise<number> {
    return (await this.getBillingSummary(freemiusUserId)).quota
  }

  /**
   * Resolve the Freemius user id for an email, or null if none exists yet.
   *
   * The provision gate calls this to bind freemiusUserId on a user's first
   * create (BILLING.md §3/§4.3): the checkout is opened with the Clerk email and
   * `readonly_user`, so the Freemius account carries that exact email and this
   * lookup hits it. `retrieveByEmail` collapses a not-found (and, unfortunately,
   * an API error) into null — the gate treats null as "no account yet" → new
   * purchase, which self-heals on the next attempt once Freemius has the user.
   *
   * @param email - The user's Clerk primary email.
   * @returns The Freemius user id as a string, or null if no account matches.
   */
  async findFreemiusUserIdByEmail(email: string): Promise<string | null> {
    const user = await this.freemius.api.user.retrieveByEmail(email)
    return user?.id ? idToString(user.id) : null
  }

  /**
   * Authorized overlay settings for an existing license (upgrade or convert).
   *
   * Resolves license_id server-side from the Clerk user row — the client must
   * not send it (BILLING.md §7). Omit `quota` to convert at the current quota;
   * pass a number to authorize an add-quota upgrade.
   */
  async createLicenseScopedCheckout(
    clerkUserId: string,
    options?: { quota: number }
  ) {
    const user = await this.db.user.findUnique({ where: { id: clerkUserId } })
    if (!user) {
      throw new HttpException('User not found', HttpStatus.NOT_FOUND)
    }
    if (!user.freemiusUserId) {
      throw new HttpException(
        {
          error: 'no_license',
          message: 'No billing account linked yet. Start a trial first.'
        },
        HttpStatus.NOT_FOUND
      )
    }

    const purchases = await this.freemius.purchase.retrievePurchases(
      user.freemiusUserId
    )
    if (purchases.length === 0) {
      throw new HttpException(
        {
          error: 'no_license',
          message: 'No active license found for this account.'
        },
        HttpStatus.NOT_FOUND
      )
    }

    const licenseId = purchases[0].licenseId
    const checkout = await this.freemius.checkout.create({
      licenseId,
      planId: env.FS_PLAN_ID,
      isSandbox: this.isSandbox,
      ...(options !== undefined ? { quota: options.quota } : {})
    })

    return { settings: checkout.getOptions() }
  }

  /**
   * Sandbox params ({ ctx, token }) for the client-built new-purchase overlay.
   *
   * The new-purchase / trial overlay is opened client-side with only public
   * values, so it can't sign its own sandbox token. We mint it here (needs the
   * secret key) and the board passes it to the overlay. License-scoped checkouts
   * don't need this — their sandbox flag rides in the server-built settings.
   *
   * Returns null in production so the live overlay can never be put in sandbox
   * mode, regardless of what the client requests.
   */
  async getNewPurchaseSandboxParams(): Promise<{
    ctx: string
    token: string
  } | null> {
    if (!this.isSandbox) return null
    return this.freemius.checkout.getSandboxParams()
  }

  /** Whether checkout overlays should open in Freemius sandbox/test mode. */
  private get isSandbox(): boolean {
    return env.NODE_ENV !== 'production'
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
  private async reconcileLicenseWebhook(
    payload: FreemiusWebhookPayload
  ): Promise<void> {
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

    // Trigger reconciliation. The reconciler maps freemiusUserId → our users row
    // and no-ops if there is no row (nothing to reconcile).
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
   * Confirm an empty retrievePurchases result really means "no active license".
   *
   * The SDK collapses API errors into [], so an empty array is ambiguous. A raw
   * status-only request disambiguates (no body read):
   *   - 404 — user not found → genuinely no license (returns)
   *   - 200 — user exists, no active license → genuinely no license (returns)
   *   - other — API error → throw, so callers retry/degrade instead of treating
   *     an outage as quota 0
   *
   * @param freemiusUserId - Freemius user id to look up.
   * @throws {FreemiusApiError} When Freemius returns a status other than 404 or 200.
   */
  private async assertNoActiveLicense(freemiusUserId: string): Promise<void> {
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
        return
      default:
        throw new FreemiusApiError(freemiusUserId, response.status)
    }
  }
}
