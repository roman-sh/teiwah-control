import { Injectable } from '@nestjs/common'
import { createClerkClient, type ClerkClient } from '@clerk/backend'

/**
 * Thin wrapper over the Clerk backend SDK for live identity reads.
 *
 * The provision gate binds freemiusUserId by email (BILLING.md §3/§4.3), and it
 * must derive that email server-side rather than trust the client or wait on the
 * Clerk `user.created` webhook. So it asks Clerk directly with the secret key.
 */
@Injectable()
export class ClerkService {
  private readonly clerk: ClerkClient

  constructor() {
    this.clerk = createClerkClient({ secretKey: env.CLERK_SECRET_KEY })
  }

  /**
   * Primary email for a Clerk user, fetched live from Clerk.
   *
   * @param clerkUserId - The authenticated Clerk user id (our internal user id).
   * @returns The primary email, or null if the user has none resolvable.
   */
  async getPrimaryEmail(clerkUserId: string): Promise<string | null> {
    const user = await this.clerk.users.getUser(clerkUserId)
    return user.primaryEmailAddress?.emailAddress ?? null
  }
}
