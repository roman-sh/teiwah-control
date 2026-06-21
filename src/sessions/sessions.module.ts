import { Module } from '@nestjs/common'
import { DbModule } from '../db/db.module'
import { SessionsController } from './sessions.controller'
import { InternalController } from './internal.controller'
import { K8sService } from './k8s.service'
import { ZuploService } from './zuplo.service'
import { SessionsService } from './sessions.service'

@Module({
  imports: [DbModule],
  controllers: [SessionsController, InternalController],
  providers: [K8sService, ZuploService, SessionsService],
  exports: [SessionsService]
})
export class SessionsModule {}
