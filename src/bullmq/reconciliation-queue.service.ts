import { Injectable } from '@nestjs/common'
import { InjectQueue } from '@nestjs/bullmq'
import { Queue } from 'bullmq'

export const RECONCILIATION_QUEUE_NAME = 'billing-reconciliation'

/** Job type label inside the queue (BullMQ requires a name on `queue.add`). */
const RECONCILIATION_JOB_NAME = 'reconcile'
/** Coalesce burst of license webhooks before one reconcile runs. */
export const RECONCILIATION_DELAY_MS = 5 * 60 * 1000
export const RECONCILIATION_ATTEMPTS = 3
export const RECONCILIATION_BACKOFF_DELAY_MS = 30_000

/** Payload the reconciliation worker reads when the delayed job fires. */
export type ReconciliationJobData = {
  freemiusUserId: string
}

/**
 * Billing reconciliation queue producer.
 *
 * Why a queue: Freemius can emit many license.* events for the same user.
 * Reconciliation is destructive (session teardown), so only one run per user
 * should be in flight. Webhooks enqueue work; the worker re-fetches Freemius and
 * deletes excess sessions (see BILLING.md).
 *
 * Why jobId = freemiusUserId: BullMQ treats jobId as unique while the job exists.
 * Duplicate webhooks for the same user are ignored — no custom dedup tables or
 * locks. A short delay coalesces bursts before the worker runs.
 */
@Injectable()
export class ReconciliationQueueService {
  constructor(
    @InjectQueue(RECONCILIATION_QUEUE_NAME)
    private readonly queue: Queue<ReconciliationJobData>
  ) {}

  async enqueueReconciliation(data: ReconciliationJobData): Promise<void> {
    // jobId = freemiusUserId dedupes while a job exists; duplicate webhooks are no-ops.
    const job = await this.queue.add(RECONCILIATION_JOB_NAME, data, {
      jobId: data.freemiusUserId,
      delay: RECONCILIATION_DELAY_MS
    })

    log.info(
      { freemiusUserId: data.freemiusUserId, jobId: job.id },
      'Reconciliation job enqueued'
    )
  }
}
