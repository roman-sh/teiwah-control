import { Module } from '@nestjs/common'
import { DbModule } from '../db/db.module'
import { BullMqModule } from '../bullmq/bullmq.module'
import { SessionsModule } from '../sessions/sessions.module'
import { FreemiusService } from './freemius.service'
import { FreemiusController } from './freemius.controller'
import { ReconciliationProcessor } from './reconciliation.processor'

/**
 * Billing domain: everything Freemius (entitlement, licensing, and later
 * checkout). Organized by functionality rather than by transport, so the
 * Freemius webhook controller lives here next to the service it drives instead
 * of in a generic webhooks module.
 *
 * - imports DbModule because binding reads/writes the `users` table.
 * - imports BullMqModule for the reconciliation queue producer and worker.
 * - exports FreemiusService so other domains (e.g. sessions, for entitlement
 *   gating) can consume billing logic without depending on the controller.
 */
@Module({
  imports: [DbModule, BullMqModule, SessionsModule],
  controllers: [FreemiusController],
  providers: [FreemiusService, ReconciliationProcessor],
  exports: [FreemiusService]
})
export class BillingModule {}
