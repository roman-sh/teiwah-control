import { Injectable } from '@nestjs/common'
import { DbService } from '../db/db.service'
import { K8sService } from './k8s.service'
import { ZuploService } from './zuplo.service'

@Injectable()
export class SessionsService {
  constructor(
    private readonly zuploService: ZuploService,
    private readonly k8sService: K8sService,
    private readonly db: DbService
  ) {}

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
