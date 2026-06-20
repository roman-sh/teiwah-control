import { Injectable } from '@nestjs/common'
import type { EmailAddressJSON, WebhookEvent } from '@clerk/backend'
import { DbService } from '../db/db.service'

export type ClerkUserSyncWebhook = Extract<
  WebhookEvent,
  { type: 'user.created' | 'user.updated' }
>

@Injectable()
export class UsersService {
  constructor(private readonly db: DbService) {}

  /**
   * Keeps `users.email` in sync with Clerk's primary email.
   * Called on `user.created` (initial row) and `user.updated` (email change).
   * Needed for Freemius bootstrap binding, which matches on exact email before
   * `freemiusUserId` is set. Post-bind, entitlement uses `freemiusUserId`.
   */
  async syncFromClerkWebhook(payload: ClerkUserSyncWebhook): Promise<void> {
    const { id, email_addresses, primary_email_address_id } = payload.data
    const email = resolvePrimaryEmail(email_addresses, primary_email_address_id)

    if (!email) {
      log.warn(
        { clerkUserId: id, event: payload.type },
        'Clerk user webhook with no email — skipped'
      )
      return
    }

    await this.db.user.upsert({
      where: { id },
      create: { id, email },
      update: { email }
    })

    log.info({ clerkUserId: id, email, event: payload.type }, 'User synced from Clerk webhook')
  }
}

function resolvePrimaryEmail(
  addresses: EmailAddressJSON[] | undefined,
  primaryId: string | null | undefined
): string | undefined {
  if (!addresses?.length) return undefined

  if (primaryId) {
    const primary = addresses.find((a) => a.id === primaryId)
    if (primary) return primary.email_address
  }

  return addresses[0].email_address
}
