import { Module } from '@nestjs/common'
import { DbModule } from '../db/db.module'
import { FreemiusService } from './freemius.service'
import { FreemiusController } from './freemius.controller'

/**
 * Billing domain: everything Freemius (entitlement, licensing, and later
 * checkout). Organized by functionality rather than by transport, so the
 * Freemius webhook controller lives here next to the service it drives instead
 * of in a generic webhooks module.
 *
 * - imports DbModule because binding reads/writes the `users` table.
 * - exports FreemiusService so other domains (e.g. sessions, for entitlement
 *   gating) can consume billing logic without depending on the controller.
 */
@Module({
  imports: [DbModule],
  controllers: [FreemiusController],
  providers: [FreemiusService],
  exports: [FreemiusService]
})
export class BillingModule {}
