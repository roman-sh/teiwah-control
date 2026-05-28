import { Module } from '@nestjs/common'
import { DbModule } from './db.module'
import { HealthController } from './health.controller'
import { SessionsModule } from './sessions.module'

@Module({
  imports: [DbModule, SessionsModule],
  controllers: [HealthController]
})
export class AppModule {}
