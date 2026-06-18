import { Module } from '@nestjs/common'
import { DbModule } from './db/db.module'
import { HealthController } from './health.controller'
import { SessionsModule } from './sessions/sessions.module'
import { UsersModule } from './users/users.module'

@Module({
  imports: [DbModule, SessionsModule, UsersModule],
  controllers: [HealthController]
})
export class AppModule {}
