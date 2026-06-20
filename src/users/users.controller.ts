import {
  Controller,
  Post,
  Body,
  HttpException,
  HttpStatus
} from '@nestjs/common'
import type { WebhookEvent } from '@clerk/backend'
import { UsersService } from './users.service'

@Controller('webhooks')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Post('clerk')
  async clerk(@Body() body: WebhookEvent) {
    if (body.type !== 'user.created' && body.type !== 'user.updated') {
      return { received: true }
    }

    try {
      await this.usersService.syncFromClerkWebhook(body)
      return { received: true }
    } catch (error) {
      log.error(error, `Clerk ${body.type} handler failed`)
      throw new HttpException(
        'Handler failed',
        HttpStatus.INTERNAL_SERVER_ERROR
      )
    }
  }
}
