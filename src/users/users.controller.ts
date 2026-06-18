import {
  Controller,
  Post,
  Body,
  HttpException,
  HttpStatus
} from '@nestjs/common'
import {
  UsersService,
  type ClerkUserCreatedPayload
} from './users.service'

@Controller('webhooks')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Post('clerk')
  async clerk(@Body() body: ClerkUserCreatedPayload) {
    if (body.type !== 'user.created') {
      return { received: true }
    }

    try {
      await this.usersService.upsertFromClerkUserCreated(body)
      return { received: true }
    } catch (error) {
      log.error(error, 'Clerk user.created handler failed')
      throw new HttpException(
        'Handler failed',
        HttpStatus.INTERNAL_SERVER_ERROR
      )
    }
  }
}
