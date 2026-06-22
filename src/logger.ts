import pino from 'pino'
import type { LoggerOptions, TransportTargetOptions } from 'pino'

/**
 * Single logger config for control. One Pino instance fans out to two targets:
 *   - pino-pretty  → stdout, colorized, human-readable (always on)
 *   - @logtail/pino → Better Stack, plain JSON (only when a source token is set,
 *                     so local dev stays pretty-only)
 *
 * nestjs-pino reuses this same instance (see app.module.ts), so there is exactly
 * one logger across the app — direct `log.*` calls and Nest's framework logs all
 * land in the same place.
 */
const level = process.env.LOG_LEVEL ?? 'info'
const sourceToken = process.env.BETTERSTACK_SOURCE_TOKEN
const ingestingHost = process.env.BETTERSTACK_INGESTING_HOST

const targets: TransportTargetOptions[] = [
  {
    target: 'pino-pretty',
    level,
    options: {
      colorize: true,
      translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l',
      ignore: 'pid,hostname'
    }
  }
]

// Ship JSON to Better Stack only when configured (prod). No token → stdout only.
if (sourceToken && ingestingHost) {
  targets.push({
    target: '@logtail/pino',
    level,
    options: {
      sourceToken,
      options: { endpoint: `https://${ingestingHost}` }
    }
  })
}

export const loggerOptions: LoggerOptions = {
  level,
  base: { service: 'control' },
  transport: { targets }
}

globalThis.log = pino(loggerOptions)
