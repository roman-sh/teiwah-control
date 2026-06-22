import { z } from 'zod'

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production']),
  PORT: z.string(),
  // Logging — read directly by logger.ts (process.env) so they load before env
  // parsing; declared here so deploys document/validate them. All optional:
  // no Better Stack token → logs stay stdout-only (local dev).
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .optional(),
  BETTERSTACK_SOURCE_TOKEN: z.string().optional(),
  BETTERSTACK_INGESTING_HOST: z.string().optional(),
  DATABASE_URL: z.string(),
  REDIS_URL: z.string(),
  CONTROL_APP_BASE_URL: z.string(),
  SESSION_WORKER_IMAGE: z.string(),
  SESSION_WORKER_PORT: z.string(),
  IMAGE_PULL_SECRET: z.string(),
  K8S_NAMESPACE: z.string(),
  ZUPLO_API_KEY: z.string(),
  ZUPLO_ACCOUNT: z.string(),
  ZUPLO_KEY_BUCKET: z.string(),
  ZUPLO_API_BASE: z.string(),
  FS_PRODUCT_ID: z.string(),
  FS_PLAN_ID: z.string(),
  FS_PRICING_ID: z.string(),
  FS_API_KEY: z.string(),
  FS_PUBLIC_KEY: z.string(),
  FS_SECRET_KEY: z.string(),
  CLERK_SECRET_KEY: z.string()
})

export type Env = z.infer<typeof envSchema>
