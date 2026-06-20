import { Module } from '@nestjs/common'
import { DbModule } from './db/db.module'
import { HealthController } from './health.controller'
import { SessionsModule } from './sessions/sessions.module'
import { UsersModule } from './users/users.module'
import { BillingModule } from './billing/billing.module'

@Module({
  imports: [DbModule, SessionsModule, UsersModule, BillingModule],
  controllers: [HealthController]
})
export class AppModule {}
