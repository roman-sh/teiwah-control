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
import {
  uniqueNamesGenerator,
  adjectives,
  animals
} from 'unique-names-generator'
import { randomBytes } from 'crypto'
import { K8sService } from './k8s.service'
import { ZuploService } from './zuplo.service'
import { SessionsService } from './sessions.service'
import { DbService } from '../db/db.service'
import { UserIdHeaderGuard } from './user-id-header.guard'

@Controller('sessions')
@UseGuards(UserIdHeaderGuard)
export class SessionsController {
  constructor(
    private readonly k8sService: K8sService,
    private readonly zuploService: ZuploService,
    private readonly sessionsService: SessionsService,
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
   * Provision a new session: k8s worker pod → Zuplo consumer + API key → DB row.
   * Returns full apiKey once; apiKeyMasked is persisted for later list views.
   */
  @Post()
  async createSession(@Headers('x-user-id') userId: string) {
    const userMascot = uniqueNamesGenerator({
      dictionaries: [adjectives, animals],
      separator: '-',
      length: 2
    })
    const suffix = randomBytes(2).toString('hex')
    const sessionId = `${userMascot}-${suffix}`

    try {
      // 1. Spin up Kubernetes Pod first. If this fails, it throws an error
      // and we never reach the DB step, preventing "ghost" records in the DB.
      await this.k8sService.createSessionWorker(sessionId)

      // 2. Zuplo Consumer (name = sessionId) + API key for POST /messages
      const { apiKey, apiKeyMasked } =
        await this.zuploService.createSessionConsumer(sessionId)

      // 3. Save to Prisma (PostgreSQL) only after k8s + Zuplo succeed
      await this.dbService.session.create({
        data: {
          id: sessionId,
          userId,
          apiKeyMasked
        }
      })

      this.k8sService.startProvisioningWatch(sessionId)

      return {
        sessionId,
        apiKey,
        apiKeyMasked,
        status: 'provisioning',
        message: 'Session is spinning up. Connect to the events endpoint soon.'
      }
    } catch (error) {
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
