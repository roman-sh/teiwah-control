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
import { DbService } from '../db/db.service'
import { UserIdHeaderGuard } from './user-id-header.guard'

@Controller('sessions')
@UseGuards(UserIdHeaderGuard)
export class SessionsController {
  constructor(
    private readonly zuploService: ZuploService,
    private readonly sessionsService: SessionsService,
    private readonly provisionService: ProvisionService,
    private readonly dbService: DbService
  ) {}

  /**
   * GET /sessions
   *
   * List sessions for the authenticated user (x-user-id header from Zuplo).
   * Returns inventory only — no worker SSE or live status.
   */
  @Get()
  async getUserSessions(@Headers('x-user-id') userId: string) {
    try {
      const sessions = await this.dbService.activeSession.findMany({
        where: { userId },
        // Oldest first — dashboard shows sessions in creation order.
        orderBy: { createdAt: 'asc' }
      })

      return sessions.map((session) => ({
        sessionId: session.id,
        phoneNumber: session.phoneNumber,
        webhookUrl: session.webhookUrl,
        apiKeyMasked: session.apiKeyMasked,
        createdAt: session.createdAt
      }))
    } catch (error) {
      log.error(error, `Failed to fetch sessions for user ${userId}`)
      throw new HttpException(
        'Failed to fetch sessions',
        HttpStatus.INTERNAL_SERVER_ERROR
      )
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
