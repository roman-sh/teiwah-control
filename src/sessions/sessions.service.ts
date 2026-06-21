import { Injectable } from '@nestjs/common'
import {
  uniqueNamesGenerator,
  adjectives,
  animals
} from 'unique-names-generator'
import { randomBytes } from 'crypto'
import { DbService } from '../db/db.service'
import { K8sService } from './k8s.service'
import { ZuploService } from './zuplo.service'

/**
 * Session lifecycle mechanics only — k8s, Zuplo, DB. No billing/quota concerns:
 * the provision gate (upward) and reconciler (downward) live in provision/ and
 * call into this service. Keeping billing out keeps the lifecycle reusable by
 * both enforcement arms without a circular dependency.
 */
@Injectable()
export class SessionsService {
  constructor(
    private readonly zuploService: ZuploService,
    private readonly k8sService: K8sService,
    private readonly db: DbService
  ) {}

  /**
   * Provision a new session: k8s worker → Zuplo consumer → DB row.
   * The caller (ProvisionService) is responsible for running the provision gate
   * first. Returns full apiKey once; apiKeyMasked is persisted for list views.
   */
  async createSession(userId: string) {
    const sessionId = `${uniqueNamesGenerator({
      dictionaries: [adjectives, animals],
      separator: '-',
      length: 2
    })}-${randomBytes(2).toString('hex')}`

    // k8s first — if this fails we never reach DB, so no ghost rows.
    await this.k8sService.createSessionWorker(sessionId)

    const { apiKey, apiKeyMasked } =
      await this.zuploService.createSessionConsumer(sessionId)

    await this.db.session.create({
      data: {
        id: sessionId,
        userId,
        apiKeyMasked
      }
    })

    this.k8sService.startProvisioningWatch(sessionId)

    return {
      sessionId,
      apiKey,
      apiKeyMasked,
      status: 'provisioning' as const,
      message: 'Session is spinning up. Connect to the events endpoint soon.'
    }
  }

  /**
   * Tear down a session. Zuplo first so a k8s failure leaves the worker running
   * for a clean retry; mark isDeleted last so the row stays until external
   * teardown succeeds (and remains for provision-rate counting).
   */
  async deleteSession(sessionId: string): Promise<void> {
    await this.zuploService.deleteSessionConsumer(sessionId)
    await this.k8sService.deleteSessionWorker(sessionId)
    await this.db.session.update({
      where: { id: sessionId },
      data: { isDeleted: true }
    })
  }
}
