import { Processor, WorkerHost } from '@nestjs/bullmq'
import { Job } from 'bullmq'
import { DbService } from '../db/db.service'
import { SessionsService } from '../sessions/sessions.service'
import {
  RECONCILIATION_QUEUE_NAME,
  type ReconciliationJobData
} from '../bullmq/reconciliation-queue.service'
import { FreemiusService } from './freemius.service'

/**
 * BullMQ worker for billing reconciliation (downward enforcement).
 *
 * A license.* webhook only enqueues a delayed job — it does not delete anything
 * itself. When this worker runs (~10 minutes later, see RECONCILIATION_DELAY_MS),
 * it re-reads entitlement live from Freemius and tears down sessions if the user
 * is over quota.
 *
 * This worker only ever removes sessions. It never creates them. That is
 * intentional: the POST /sessions gate handles upward enforcement separately.
 *
 * If Freemius is temporarily down, getEntitlement throws FreemiusApiError and
 * BullMQ retries the job (3 attempts with backoff — see bullmq.module).
 */
@Processor(RECONCILIATION_QUEUE_NAME)
export class ReconciliationProcessor extends WorkerHost {
  constructor(
    private readonly freemiusService: FreemiusService,
    private readonly sessionsService: SessionsService,
    private readonly db: DbService
  ) {
    super()
  }

  /**
   * Runs one reconciliation pass for a single Freemius user.
   *
   * Steps:
   *   1. Find our users row (Clerk id) from freemiusUserId on the job.
   *   2. Ask Freemius how many sessions this user may run (getEntitlement).
   *   3. Count the user's sessions in our DB.
   *   4. If count > quota, delete the excess (newest sessions first).
   *
   * @param job - BullMQ job; payload is { freemiusUserId }.
   */
  async process(job: Job<ReconciliationJobData>): Promise<void> {
    const { freemiusUserId } = job.data

    // Webhooks carry freemiusUserId, but sessions are keyed by Clerk user id.
    // If bind never happened (no matching email yet), there is nothing to reconcile.
    const user = await this.db.user.findUnique({ where: { freemiusUserId } })
    if (!user) {
      log.warn(
        { jobId: job.id, freemiusUserId },
        'Reconciliation skipped — no users row for Freemius user'
      )
      return
    }

    // Live read from Freemius — never trust quota from the webhook payload.
    // Throws on API failure so BullMQ retries instead of deleting sessions
    // based on a bad read.
    const effectiveQuota = await this.freemiusService.getEntitlement(freemiusUserId)

    // All sessions count toward quota in v1 (no suspended state yet).
    // Newest first — when quota shrinks we delete the most recently created
    // sessions and keep the oldest (default until we decide otherwise).
    const sessions = await this.db.activeSession.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      select: { id: true }
    })

    const excess = sessions.length - effectiveQuota
    if (excess <= 0) {
      // At or under quota — nothing to do. Common after upgrade or when the
      // webhook fired but entitlement did not actually change.
      log.debug(
        {
          jobId: job.id,
          freemiusUserId,
          effectiveQuota,
          activeSessions: sessions.length
        },
        'Reconciliation no-op'
      )
      return
    }

    // Over quota — delete exactly `excess` sessions via the shared teardown
    // path (k8s deployment/service/ingress/PVC, Zuplo consumer, DB row).
    // Sessions come back newest first, so the first `excess` of them are the
    // newest ones — those are the ones we drop.
    const idsToDelete = sessions
      .filter((_, index) => index < excess)
      .map(({ id }) => id)

    log.info(
      {
        jobId: job.id,
        freemiusUserId,
        userId: user.id,
        effectiveQuota,
        activeSessions: sessions.length,
        excess,
        idsToDelete,
        reason: 'active sessions exceed Freemius entitlement quota; deleting newest first'
      },
      'Reconciliation deleting excess sessions'
    )

    // One at a time — teardown logs stay grouped per session. Try all of them;
    // if any fail, throw once at the end so BullMQ retries.
    let error = false
    for (const id of idsToDelete) {
      try { await this.sessionsService.deleteSession(id) }
      catch { error = true }
    }
    if (error) throw new Error(
      'Reconciliation: one or more session deletes failed'
    )

    log.info(
      {
        jobId: job.id,
        freemiusUserId,
        effectiveQuota,
        idsToDelete
      },
      'Reconciliation complete'
    )
  }
}
