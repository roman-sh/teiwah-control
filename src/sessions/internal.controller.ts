import {
  Controller,
  Get,
  Patch,
  Param,
  Body,
  HttpException,
  HttpStatus
} from '@nestjs/common'
import { DbService } from '../db/db.service'

/**
 * Worker-facing session endpoints on `/sessions/*`.
 *
 * Called by nestwaileys pods inside the cluster (CONTROL_APP_BASE_URL), not by
 * the dashboard. No x-user-id guard — the worker already knows its session id.
 * User-facing CRUD lives in SessionsController (behind Zuplo + Clerk).
 */
@Controller('sessions')
export class InternalController {
  constructor(private readonly dbService: DbService) {}

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
      return { success: true, phoneNumber }
    } catch (error) {
      log.error(error, `Failed to update phone number for session ${id}`)
      throw new HttpException(
        'Failed to update session',
        HttpStatus.INTERNAL_SERVER_ERROR
      )
    }
  }
}
