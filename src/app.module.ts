import { randomUUID } from 'node:crypto'
import { Module, RequestMethod } from '@nestjs/common'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { LoggerModule } from 'nestjs-pino'
import { DbModule } from './db/db.module'
import { HealthController } from './health.controller'
import { SessionsModule } from './sessions/sessions.module'
import { UsersModule } from './users/users.module'

/** First non-empty value of a header that may arrive as string | string[]. */
function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

@Module({
  imports: [
    // Reuse the single Pino instance from logger.ts so direct `log.*` calls,
    // Nest framework logs, and per-request HTTP logs share one config + redaction.
    LoggerModule.forRoot({
      // Skip the DB health probe — it would flood logs with no signal.
      exclude: [{ method: RequestMethod.ALL, path: 'health' }],
      pinoHttp: {
        logger: globalThis.log,
        // Reuse an upstream request id (Zuplo will send x-request-id) or mint one,
        // and echo it back so the whole chain shares the same correlation id.
        genReqId: (req: IncomingMessage, res: ServerResponse) => {
          const id = headerValue(req.headers['x-request-id']) ?? randomUUID()
          res.setHeader('x-request-id', id)
          return id
        },
        // Stamp every request log with the identity the support agent queries on.
        customProps: (req: IncomingMessage) => {
          const params = (req as { params?: Record<string, string> }).params
          return {
            userId: headerValue(req.headers['x-user-id']),
            sessionId: params?.id
          }
        }
      }
    }),
    DbModule,
    SessionsModule,
    UsersModule
  ],
  controllers: [HealthController]
})
export class AppModule {}
