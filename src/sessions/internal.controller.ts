import {
  Controller,
  Get,
  Patch,
  Post,
  Param,
  Body,
  HttpException,
  HttpStatus
} from '@nestjs/common'
import { DbService } from '../db/db.service'
import { FreemiusService } from '../billing/freemius.service'

/**
 * Worker-facing session endpoints on `/sessions/*`.
 *
 * Called by nestwaileys pods inside the cluster (CONTROL_APP_BASE_URL), not by
 * the dashboard. No x-user-id guard — the worker already knows its session id.
 * User-facing CRUD lives in SessionsController (behind Zuplo + Clerk).
 */
@Controller('sessions')
export class InternalController {
  constructor(
    private readonly dbService: DbService,
    private readonly freemiusService: FreemiusService
  ) {}

  /**
   * GET /sessions/:id
   *
   * Return the session row from DB (webhookUrl, phoneNumber, etc.). The worker
   * calls this on startup and when it needs fresh config — e.g. to read
   * webhookUrl before forwarding inbound WhatsApp messages.
   */
  @Get(':id')
  async getSessionConfig(@Param('id') id: string) {
    try {
      const session = await this.dbService.activeSession.findUnique({
        where: { id }
      })

      if (!session) {
        throw new HttpException('Session not found', HttpStatus.NOT_FOUND)
      }

      log.debug({ sessionId: id }, 'Worker fetched session config')
      return session
    } catch (error) {
      if (error instanceof HttpException) throw error
      log.error(error, `Failed to fetch internal config for session ${id}`)
      throw new HttpException(
        'Failed to fetch session',
        HttpStatus.INTERNAL_SERVER_ERROR
      )
    }
  }

  /**
   * PATCH /sessions/:id/phone
   *
   * Save the WhatsApp phone number after the user scans the QR code. Called by
   * the worker when Baileys reports connection open; the dashboard shows the
   * number on GET /sessions (user-facing).
   */
  @Patch(':id/phone')
  async updateSessionPhone(
    @Param('id') id: string,
    @Body('phoneNumber') phoneNumber: string
  ) {
    try {
      const active = await this.dbService.activeSession.findUnique({
        where: { id }
      })
      if (!active) {
        throw new HttpException('Session not found', HttpStatus.NOT_FOUND)
      }
      await this.dbService.session.update({
        where: { id },
        data: { phoneNumber }
      })
      log.info(
        { sessionId: id, phoneNumber },
        'Session phone updated (WhatsApp connected)'
      )
      return { success: true, phoneNumber }
    } catch (error) {
      log.error(error, `Failed to update phone number for session ${id}`)
      throw new HttpException(
        'Failed to update session',
        HttpStatus.INTERNAL_SERVER_ERROR
      )
    }
  }

  /**
   * POST /sessions/:id/authorize
   *
   * Trial-abuse gate. The worker calls this the instant WhatsApp pairs and the
   * phone number becomes known (before persisting it). It blocks a TRIAL user
   * from connecting a number already tied to a DIFFERENT user's session — the
   * "new email, same number, another free trial" pattern. The worker logs the
   * device out and idles on `{ authorized: false }`.
   *
   * Order matters for cost: the duplicate check (a cheap local query) runs first
   * and authorizes the common no-duplicate case immediately. Only a duplicate
   * triggers the Freemius lookup, since the only reason to override it is a
   * paying customer (paid license) — they are never gated. Fail-open: any
   * Freemius error on that lookup returns `{ authorized: true }` so a billing
   * blip never strands a legitimate (often paying) user.
   */
  @Post(':id/authorize')
  async authorizeSession(
    @Param('id') id: string,
    @Body('phoneNumber') phoneNumber: string
  ): Promise<{ authorized: boolean; reason?: string }> {
    const session = await this.dbService.activeSession.findUnique({
      where: { id }
    })
    if (!session) {
      throw new HttpException('Session not found', HttpStatus.NOT_FOUND)
    }

    // No number to check (shouldn't happen on a real pair) — let it through.
    if (!phoneNumber) return { authorized: true }

    // Duplicate = this number already belongs to a DIFFERENT user. Use `session`
    // (not `activeSession`) so a deleted prior session still counts — otherwise
    // deleting session #1 would evade the gate. Same-user re-use (delete +
    // recreate, or reconnect) is allowed. No duplicate → authorize immediately,
    // no Freemius call.
    const duplicate = await this.dbService.session.findFirst({
      where: { phoneNumber, userId: { not: session.userId }, id: { not: id } }
    })
    if (!duplicate) return { authorized: true }

    // There IS a duplicate. The only reason to allow it is a paying customer
    // (paid license) — e.g. someone who re-registered under a new email. On any
    // Freemius error, fail open rather than block a paying user we can't verify.
    try {
      const user = await this.dbService.user.findUnique({
        where: { id: session.userId }
      })
      if (
        user?.freemiusUserId &&
        (await this.freemiusService.hasPaidLicense(user.freemiusUserId))
      ) {
        return { authorized: true }
      }
    } catch (error) {
      log.warn(
        error,
        `Paid-license check failed for session ${id}; authorizing (fail-open)`
      )
      return { authorized: true }
    }

    log.warn(
      { sessionId: id, phoneNumber, duplicateUserId: duplicate.userId },
      '[Abuse] Trial reusing a number tied to another account; blocking'
    )
    return { authorized: false, reason: 'number_in_use' }
  }
}
