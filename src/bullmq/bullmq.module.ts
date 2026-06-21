import { Module } from '@nestjs/common'
import { BullModule } from '@nestjs/bullmq'
import { bullmqConnection } from './bullmq.connection'
import {
  RECONCILIATION_ATTEMPTS,
  RECONCILIATION_BACKOFF_DELAY_MS,
  RECONCILIATION_QUEUE_NAME,
  ReconciliationQueueService
} from './reconciliation-queue.service'

/**
 * BullMQ infrastructure. `forRoot` once (shared Redis); each queue gets its own
 * `registerQueue` with queue-specific defaults. Add future queues here.
 *
 * Processors live with the code that owns the job (e.g. ReconciliationProcessor
 * in provision/, registered via SessionsModule). Export `BullModule` so the
 * owning module can register `@Processor` handlers against the same queue.
 */
@Module({
  imports: [
    BullModule.forRoot({
      connection: bullmqConnection
    }),
    BullModule.registerQueue({
      name: RECONCILIATION_QUEUE_NAME,
      defaultJobOptions: {
        attempts: RECONCILIATION_ATTEMPTS,
        backoff: {
          type: 'exponential',
          delay: RECONCILIATION_BACKOFF_DELAY_MS
        },
        removeOnComplete: true,
        removeOnFail: true
      }
    })
  ],
  providers: [ReconciliationQueueService],
  exports: [BullModule, ReconciliationQueueService]
})
export class BullMqModule {}
