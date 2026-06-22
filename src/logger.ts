import type { LoggerService } from '@nestjs/common'
import pino from 'pino'

const pinoLogger = pino({
  level: 'info',
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l',
      ignore: 'pid,hostname'
    }
  }
})

globalThis.log = pinoLogger

/** Wire Nest's logger to the same Pino instance (replaces `logger: false`). */
export const nestLogger: LoggerService = {
  log: (message, context?) =>
    pinoLogger.info(context ? { context } : {}, String(message)),
  error: (message, trace?, context?) =>
    pinoLogger.error(
      { ...(context && { context }), ...(trace && { trace }) },
      String(message)
    ),
  warn: (message, context?) =>
    pinoLogger.warn(context ? { context } : {}, String(message)),
  debug: (message, context?) =>
    pinoLogger.debug(context ? { context } : {}, String(message)),
  verbose: (message, context?) =>
    pinoLogger.trace(context ? { context } : {}, String(message))
}
