import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Headers,
  HttpException,
  HttpStatus,
  UseGuards
} from '@nestjs/common'
import { ZuploService } from './zuplo.service'
import { SessionsService } from './sessions.service'
import { ProvisionService } from '../provision/provision.service'
import { ProvisionGateBlockedException } from '../provision/provision-gate.exception'
import { FreemiusService } from '../billing/freemius.service'
import { DbService } from '../db/db.service'
import { UserIdHeaderGuard } from './user-id-header.guard'

/**
 * Live per-user billing block for the dashboard (BILLING.md §7). `null` only on
 * Freemius failure — a user with no license still gets a quota-0 block. `used`
 * is omitted: the client derives it from the `sessions` array in the response.
 */
type BillingBlock = {
  quota: number
  isTrial: boolean
  trialEndsAt: Date | null
}

@Controller('sessions')
@UseGuards(UserIdHeaderGuard)
export class SessionsController {
  constructor(
    private readonly zuploService: ZuploService,
    private readonly sessionsService: SessionsService,
    private readonly provisionService: ProvisionService,
    private readonly freemiusService: FreemiusService,
    private readonly dbService: DbService
  ) {}

  /**
   * GET /sessions
   *
   * List sessions for the authenticated user (x-user-id header from Zuplo),
   * plus a live `billing` block driving the dashboard buttons/labels. Sessions
   * come from our DB and always render; billing degrades to `null` if Freemius
   * is unavailable (BILLING.md §7).
   */
  @Get()
  async getUserSessions(@Headers('x-user-id') userId: string) {
    try {
      const [user, sessions] = await Promise.all([
        this.dbService.user.findUnique({ where: { id: userId } }),
        this.dbService.activeSession.findMany({
          where: { userId },
          // Oldest first — dashboard shows sessions in creation order.
          orderBy: { createdAt: 'asc' }
        })
      ])

      // No users row (?.) or row not yet linked to Freemius (?? null) both mean
      // "no billing account" — collapse to null so buildBillingBlock returns the
      // quota-0 block instead of hitting Freemius.
      const billing = await this.buildBillingBlock(
        user?.freemiusUserId ?? null
      )

      return {
        sessions: sessions.map((session) => ({
          sessionId: session.id,
          phoneNumber: session.phoneNumber,
          webhookUrl: session.webhookUrl,
          apiKeyMasked: session.apiKeyMasked,
          createdAt: session.createdAt
        })),
        billing
      }
    } catch (error) {
      log.error(error, `Failed to fetch sessions for user ${userId}`)
      throw new HttpException(
        'Failed to fetch sessions',
        HttpStatus.INTERNAL_SERVER_ERROR
      )
    }
  }

  /**
   * Compose the live billing block for GET /sessions.
   *
   * No linked Freemius account → genuine no-entitlement (quota 0), not a
   * failure. Otherwise read live from Freemius; on any failure degrade to
   * `null` so the grid still renders from our DB (display-only, never gates).
   *
   * Note: unregistered (no account) and expired (had a license, now lapsed)
   * both surface as quota 0 — the block carries entitlement level, not account
   * history. That's intentional: the POST /sessions gate distinguishes them via
   * freemiusUserId (new-purchase checkout {} vs license-scoped re-subscribe) and
   * is the authority on the create action. Add a status discriminator here only
   * if the dashboard needs different proactive copy for the two.
   */
  private async buildBillingBlock(
    freemiusUserId: string | null
  ): Promise<BillingBlock | null> {
    if (!freemiusUserId) {
      return { quota: 0, isTrial: false, trialEndsAt: null }
    }

    try {
      return await this.freemiusService.getBillingSummary(freemiusUserId)
    } catch (error) {
      log.warn(
        error,
        `Billing block unavailable for user (freemiusUserId=${freemiusUserId}) — degrading to null`
      )
      return null
    }
  }

  /**
   * POST /sessions
   *
   * Gated create. The provision gate (abuse caps + Freemius quota) lives in
   * ProvisionService; on success it delegates to SessionsService for the
   * k8s/Zuplo/DB mechanics. Lifecycle-only handlers (delete, webhook, api-key)
   * stay on SessionsService below.
   */
  @Post()
  async createSession(@Headers('x-user-id') userId: string) {
    try {
      return await this.provisionService.createSession(userId)
    } catch (error) {
      // Gate blocks (limits, quota) — expected client response, not a server error.
      if (error instanceof ProvisionGateBlockedException) throw error
      // k8s, Zuplo, or DB failed — unexpected; log and return 500.
      log.error(error, 'Failed to provision session')
      throw new HttpException(
        'Failed to provision session',
        HttpStatus.INTERNAL_SERVER_ERROR
      )
    }
  }

  /**
   * GET /sessions/:id/api-key
   *
   * Reveal the full Zuplo API key for a session (dashboard "Show").
   * Fetched from Zuplo on demand — not stored in DB.
   */
  @Get(':id/api-key')
  async getSessionApiKey(@Param('id') id: string) {
    try {
      const apiKey = await this.zuploService.getSessionConsumerApiKey(id)
      return { apiKey }
    } catch (error) {
      if (error instanceof HttpException) throw error
      log.error(error, `Failed to fetch API key for session ${id}`)
      throw new HttpException(
        'Failed to fetch API key',
        HttpStatus.INTERNAL_SERVER_ERROR
      )
    }
  }

  /**
   * PATCH /sessions/:id/webhook
   *
   * Save the inbound webhook URL for a session (WhatsApp → Teiwah → user URL).
   */
  @Patch(':id/webhook')
  async updateWebhook(
    @Param('id') id: string,
    @Headers('x-user-id') userId: string,
    @Body('webhookUrl') webhookUrl: string
  ) {
    try {
      // Ensure the session belongs to the user
      const session = await this.dbService.activeSession.findUnique({
        where: { id }
      })

      if (!session) {
        throw new HttpException('Session not found', HttpStatus.NOT_FOUND)
      }

      await this.dbService.session.update({
        where: { id },
        data: { webhookUrl }
      })

      return { success: true, webhookUrl }
    } catch (error) {
      if (error instanceof HttpException) throw error
      log.error(error, `Failed to update webhook for session ${id}`)
      throw new HttpException(
        'Failed to update webhook',
        HttpStatus.INTERNAL_SERVER_ERROR
      )
    }
  }

  /**
   * DELETE /sessions/:id
   *
   * Tear down a session: Zuplo consumer, then k8s worker, then isDeleted in DB.
   */
  @Delete(':id')
  async deleteSession(@Param('id') id: string) {
    try {
      await this.sessionsService.deleteSession(id)
      return { success: true, message: 'Session deleted successfully' }
    } catch (error) {
      log.error(error, `Failed to delete session ${id}`)

      // If the error is an intentional HTTP error we threw earlier (like a 404),
      // we re-throw it so the frontend gets the correct status code.
      // If it's a random crash or DB error, we fall through and throw a generic 500.
      if (error instanceof HttpException) throw error
      throw new HttpException(
        'Failed to delete session',
        HttpStatus.INTERNAL_SERVER_ERROR
      )
    }
  }
}
