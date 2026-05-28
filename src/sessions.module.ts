import { Module } from '@nestjs/common'
import { DbModule } from './db.module'
import { SessionsController } from './sessions.controller'
import { InternalController } from './internal.controller'
import { K8sService } from './k8s.service'

@Module({
  imports: [DbModule],
  controllers: [SessionsController, InternalController],
  providers: [K8sService]
})
export class SessionsModule {}
