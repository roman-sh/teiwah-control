import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException
} from '@nestjs/common'
import type { Request } from 'express'
import { DbService } from '../db/db.service'

/**
 * Ownership gate for session-specific routes (`/sessions/:id/...`).
 *
 * A session id travels in the URL and is guessable, while `x-user-id` (set by
 * Zuplo from the verified Clerk token) is the trustworthy caller identity. This
 * guard ties the two together: it looks up who owns the `:id` in the URL and
 * confirms it's the caller, so a logged-in user can't act on someone else's
 * session by supplying a foreign id.
 *
 * Runs after the class-level UserIdHeaderGuard, so `x-user-id` is already known
 * to be present here.
 *
 * Missing row and wrong-owner both 404 (never 403): identical responses so the
 * endpoint can't be used to probe which session ids exist. Already-deleted
 * sessions fall out of the active_sessions view → also 404, which is the right
 * "nothing here for you".
 *
 * Applied per-route (not class-wide) because the collection routes
 * (GET/POST /sessions) have no `:id` and are already scoped by `x-user-id`.
 */
@Injectable()
export class SessionOwnerGuard implements CanActivate {
  constructor(private readonly db: DbService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>()
    // A path param is always a single string at runtime (Express just types it
    // loosely). The x-user-id header stays as-is — comparing it against the
    // owner below naturally fails for a missing/array value, yielding a 404.
    const sessionId = request.params.id as string
    const userId = request.headers['x-user-id']

    const session = await this.db.activeSession.findUnique({
      where: { id: sessionId }
    })

    if (!session || session.userId !== userId) {
      throw new NotFoundException('Session not found')
    }

    return true
  }
}
