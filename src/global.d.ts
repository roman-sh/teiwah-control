import type { Logger } from 'pino'
import type { Env } from './env.schema'

declare global {
  var log: Logger
  var env: Env
}
