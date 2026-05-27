import {
  Controller,
  Get,
  Patch,
  Param,
  Body,
  HttpException,
  HttpStatus
} from '@nestjs/common'
import { DbService } from './db.service'

@Controller('sessions')
export class InternalController {
  constructor(private readonly dbService: DbService) {}

  @Get(':id')
  async getSessionConfig(@Param('id') id: string) {
    try {
      const session = await this.dbService.session.findUnique({
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

  @Patch(':id/phone')
  async updateSessionPhone(
    @Param('id') id: string,
    @Body('phoneNumber') phoneNumber: string
  ) {
    try {
      const session = await this.dbService.session.update({
        where: { id },
        data: { phoneNumber }
      })
      return { success: true, phoneNumber: session.phoneNumber }
    } catch (error) {
      log.error(error, `Failed to update phone number for session ${id}`)
      throw new HttpException(
        'Failed to update session',
        HttpStatus.INTERNAL_SERVER_ERROR
      )
    }
  }
}
