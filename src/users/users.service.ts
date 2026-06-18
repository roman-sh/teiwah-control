import { Injectable } from '@nestjs/common'
import { DbService } from '../db/db.service'

type ClerkEmailAddress = {
  id: string
  email_address: string
}

export type ClerkUserCreatedPayload = {
  type: string
  data: {
    id: string
    email_addresses?: ClerkEmailAddress[]
    primary_email_address_id?: string | null
  }
}

@Injectable()
export class UsersService {
  constructor(private readonly db: DbService) {}

  async upsertFromClerkUserCreated(payload: ClerkUserCreatedPayload): Promise<void> {
    const { id, email_addresses, primary_email_address_id } = payload.data
    const email = resolvePrimaryEmail(email_addresses, primary_email_address_id)

    if (!email) {
      log.warn({ clerkUserId: id }, 'Clerk user.created with no email — skipped')
      return
    }

    await this.db.user.upsert({
      where: { id },
      create: { id, email },
      update: { email }
    })

    log.info({ clerkUserId: id, email }, 'User upserted from Clerk webhook')
  }
}

function resolvePrimaryEmail(
  addresses: ClerkEmailAddress[] | undefined,
  primaryId: string | null | undefined
): string | undefined {
  if (!addresses?.length) return undefined

  if (primaryId) {
    const primary = addresses.find((a) => a.id === primaryId)
    if (primary) return primary.email_address
  }

  return addresses[0].email_address
}
