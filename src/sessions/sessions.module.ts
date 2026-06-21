import { Module } from '@nestjs/common'
import { DbModule } from '../db/db.module'
import { BullMqModule } from '../bullmq/bullmq.module'
import { SessionsController } from './sessions.controller'
import { InternalController } from './internal.controller'
import { K8sService } from './k8s.service'
import { ZuploService } from './zuplo.service'
import { SessionsService } from './sessions.service'
import { FreemiusService } from '../billing/freemius.service'
import { FreemiusController } from '../billing/freemius.controller'
import { BillingController } from '../billing/billing.controller'
import { ProvisionService } from '../provision/provision.service'
import { ReconciliationProcessor } from '../provision/reconciliation.processor'

/**
 * Single domain module spanning sessions + billing + provision. The folders
 * (sessions/, billing/, provision/) keep the domains readable, but they share
 * one module so providers inject each other freely — no module boundary means
 * no cycle to break (no forwardRef, no misplaced registrations).
 *
 * Boundary is by convention, not enforced by Nest:
 *   - sessions/  — lifecycle mechanics (k8s, Zuplo, DB, delete) + worker-facing
 *   - billing/   — Freemius read + webhook (entitlement, bind, enqueue)
 *   - provision/ — enforcement that needs BOTH (gate + reconciler)
 */
@Module({
  imports: [DbModule, BullMqModule],
  controllers: [SessionsController, InternalController, FreemiusController, BillingController],
  providers: [
    K8sService,
    ZuploService,
    SessionsService,
    FreemiusService,
    ProvisionService,
    ReconciliationProcessor
  ]
})
export class SessionsModule {}
