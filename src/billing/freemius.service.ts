import { Injectable } from '@nestjs/common'
import type { EventEntity, WebhookEvent } from '@freemius/sdk'
import { DbService } from '../db/db.service'

/**
 * What Freemius actually POSTs: `WebhookEvent` plus top-level envelope fields
 * (`user_id`, etc.) that the SDK's `WebhookEvent` type omits.
 */
export type FreemiusWebhookPayload = WebhookEvent & Pick<EventEntity, 'user_id'>

/**
 * Narrowed alias for the one event shape where the license has been removed.
 *
 * The SDK models webhook payloads as a discriminated union (`WebhookEvent`),
 * but inside a `switch (payload.type)` TypeScript can't always re-narrow the
 * union for us (the `data`/`objects` shape differs per event). We cast to this
 * alias at the `license.deleted` branch so the `data.license_id` access is typed.
 */
type LicenseDeletedEvent = WebhookEvent<'license.deleted'>

@Injectable()
export class FreemiusService {
  constructor(private readonly db: DbService) {}

  /**
   * Entry point for every Freemius webhook we receive.
   *
   * TRUST MODEL (v1): we do NOT verify a signature or shared token on these
   * requests. The webhook body is treated as an untrusted *notification* only —
   * a hint that "something about a license changed". The plan is for any state
   * that actually grants entitlement to be re-fetched from the Freemius API
   * (authenticated with our own API key) rather than trusted from the payload.
   * That re-fetch is the deferred "Re-fetch + reconcile" step below.
   *
   * SCOPE (v1): we only care about `license.*` events here. Subscription and
   * payment events flow through the same endpoint but are intentionally ignored
   * for now — licenses are the single source of truth for entitlement.
   */
  async handleLicenseWebhook(payload: FreemiusWebhookPayload): Promise<void> {
    // Ignore everything that isn't a license lifecycle event (subscription.*,
    // payment.*, etc.). Returning early keeps the handler — and our logs — focused.
    if (!payload.type.startsWith('license.')) {
      log.info(
        { eventId: payload.id, type: payload.type },
        'Freemius webhook ignored — not a license event'
      )
      return
    }

    log.info(
      { eventId: payload.id, type: payload.type, userId: payload.user_id },
      'Freemius license webhook processing'
    )

    switch (payload.type) {
      case 'license.deleted': {
        // A deleted license means the user should lose access. We don't act on
        // it yet: reconciliation (tearing down over-quota sessions) depends on
        // SessionsService, which isn't built. For now we only record that it
        // happened so the event isn't silently swallowed.
        const event = payload as LicenseDeletedEvent
        log.info({ licenseId: event.data.license_id }, 'license.deleted — reconcile deferred')
        return
      }
      default:
        // Every other license event (created/updated/extended/expired/...) is
        // treated identically in v1: make sure the Freemius user is linked to
        // our local user row. We deliberately don't branch per sub-type yet.
        await this.bindFreemiusUser(payload)
    }
    // NEXT STEP (deferred): after binding, re-fetch the authoritative license
    // from the Freemius API and reconcile local state (e.g. teardown sessions
    // that now exceed the license quota). Intentionally not implemented yet.
  }

  /**
   * Links a Freemius user to our local `users` row ("binding").
   *
   * WHY THIS EXISTS: a `users` row is created by Clerk (`user.created`) at
   * sign-up and starts with `freemiusUserId = null`. Freemius is a separate
   * identity system; the only thing the two share at first purchase is the
   * email address. So we bootstrap the link by matching on email, then store
   * the Freemius user id as the *durable* key for all future events.
   *
   * KEY ASSUMPTIONS:
   *  - email is stable and unique per user across Clerk and Freemius. We rely
   *    on this only for the very first match; afterwards `freemiusUserId` wins.
   *  - binding is idempotent: replaying the same webhook is safe and cheap.
   *  - this method NEVER creates a `users` row. If there's no local user for the
   *    email, we skip — Clerk is the only source that creates users.
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

    // Fast path / idempotency: if some row already carries this freemiusUserId
    // the binding is done. We can stop without an email lookup or a write.
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

    // Bootstrap key. Only license events that include the user object carry an
    // email (e.g. a Checkout purchase). Manual/dashboard changes may not — in
    // that case we can't bootstrap the link and wait for an event that can.
    const email =
      'objects' in payload && payload.objects && 'user' in payload.objects
        ? payload.objects.user?.email
        : undefined
    if (!email) {
      log.warn(
        { eventId: payload.id, freemiusUserId },
        'Freemius license event with no user email — cannot bind'
      )
      return
    }

    log.info({ eventId: payload.id, freemiusUserId, email }, 'Freemius bind — matching email')

    // Match the Freemius email to a Clerk-created user. No match = a purchase by
    // someone who hasn't signed up in our app yet (or a different email). We do
    // NOT create a user here; we skip and let a later event (or sign-up) resolve it.
    const user = await this.db.user.findUnique({ where: { email } })
    if (!user) {
      log.warn(
        { eventId: payload.id, freemiusUserId, email },
        'No users row for Freemius email — skipped bind'
      )
      return
    }

    // Safety check: the row matched by email is already bound to a *different*
    // Freemius user. This shouldn't happen under our assumptions, so we refuse
    // to silently overwrite the link and surface it for investigation instead.
    if (user.freemiusUserId && user.freemiusUserId !== freemiusUserId) {
      log.warn(
        { eventId: payload.id, clerkUserId: user.id, email, freemiusUserId },
        'users row already bound to a different Freemius user — skipped'
      )
      return
    }

    // Persist the durable link. From now on this user is identified by
    // freemiusUserId for every future webhook, regardless of email changes.
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
