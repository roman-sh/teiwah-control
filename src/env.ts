import { envSchema } from './env.schema'

globalThis.env = envSchema.parse(process.env)
