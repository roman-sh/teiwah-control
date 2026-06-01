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
import { DbService } from './db.service'
import { UserIdHeaderGuard } from './user-id-header.guard'

@Controller('sessions')
@UseGuards(UserIdHeaderGuard)
export class SessionsController {
  constructor(
    private readonly k8sService: K8sService,
    private readonly zuploService: ZuploService,
    private readonly dbService: DbService
  ) {}

  @Get()
  async getUserSessions(@Headers('x-user-id') userId: string) {
    try {
      const sessions = await this.dbService.session.findMany({
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

  @Patch(':id/webhook')
  async updateWebhook(
    @Param('id') id: string,
    @Headers('x-user-id') userId: string,
    @Body('webhookUrl') webhookUrl: string
  ) {
    try {
      // Ensure the session belongs to the user
      const session = await this.dbService.session.findUnique({
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

  @Delete(':id')
  async deleteSession(@Param('id') id: string) {
    try {
      // 1. Fire off K8s + Zuplo deletion in the background (fire-and-forget)
      this.k8sService.deleteSessionWorker(id).catch((error) => {
        log.error(error, `Background K8s deletion failed for ${id}`)
      })
      this.zuploService.deleteSessionConsumer(id).catch((error) => {
        log.error(error, `Background Zuplo deletion failed for ${id}`)
      })

      // 2. Hard delete the DB record
      await this.dbService.session.delete({
        where: { id }
      })

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
