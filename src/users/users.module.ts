import { Module } from '@nestjs/common'
import { DbModule } from '../db/db.module'
import { UsersService } from './users.service'
import { ClerkService } from './clerk.service'
import { UsersController } from './users.controller'

@Module({
  imports: [DbModule],
  controllers: [UsersController],
  providers: [UsersService, ClerkService],
  exports: [UsersService, ClerkService]
})
export class UsersModule {}
