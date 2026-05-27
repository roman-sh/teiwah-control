import { Module } from '@nestjs/common'
import { SessionsModule } from './sessions.module'

@Module({
  imports: [SessionsModule]
})
export class AppModule {}
