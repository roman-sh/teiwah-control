import pino from 'pino'
import type { LoggerOptions, TransportTargetOptions } from 'pino'

/**
 * Single logger config for control. One Pino instance fans out to two targets:
 *   - pino-pretty   → stdout, colorized, human-readable. Filtered by LOG_LEVEL.
 *   - @logtail/pino → Better Stack, plain JSON. Receives EVERYTHING (trace floor)
 *                     so all detail stays queryable/filterable in Better Stack
 *                     regardless of the local stdout level.
 *
 * LOG_LEVEL therefore only controls stdout verbosity. The logger itself runs at
 * 'trace': pino gates at the logger level before any transport, so the floor must
 * be the most-verbose target or Better Stack would miss the lower records.
 *
 * Better Stack config is REQUIRED (env.schema), so there is no stdout-only
 * fallback — a missing token fails fast at boot rather than silently degrading.
 *
 * nestjs-pino reuses this same instance (see app.module.ts), so there is exactly
 * one logger across the app — direct `log.*` calls and Nest's framework logs all
 * land in the same place.
 */
const stdoutLevel = process.env.LOG_LEVEL ?? 'info'

const targets: TransportTargetOptions[] = [
  {
    target: 'pino-pretty',
    level: stdoutLevel,
    options: {
      colorize: true,
      translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l',
      ignore: 'pid,hostname'
    }
  },
  {
    // Ship everything; filter in the Better Stack UI, not at the source.
    target: '@logtail/pino',
    level: 'trace',
    options: {
      sourceToken: process.env.BETTERSTACK_SOURCE_TOKEN,
      options: {
        endpoint: `https://${process.env.BETTERSTACK_INGESTING_HOST}`
      }
    }
  }
]

export const loggerOptions: LoggerOptions = {
  // Most-verbose floor so nothing is dropped before reaching Better Stack.
  level: 'trace',
  base: { service: 'control' },
  transport: { targets }
}

globalThis.log = pino(loggerOptions)
