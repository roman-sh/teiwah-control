import { Module } from '@nestjs/common'
import { SessionsController } from './sessions.controller'
import { InternalController } from './internal.controller'
import { K8sService } from './k8s.service'
import { DbService } from './db.service'

@Module({
  controllers: [SessionsController, InternalController],
  providers: [K8sService, DbService]
})
export class SessionsModule {}
