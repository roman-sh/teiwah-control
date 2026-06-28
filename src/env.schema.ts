import { z } from 'zod'

/**
 * Control env contract. Validated at boot → global `env`.
 *
 * What to set and local vs prod values: .env.example (canonical runbook).
 * Worker pod forwarding: k8s.service.ts `env:` block.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production']),
  PORT: z.string(),

  // Logging — logger.ts reads process.env before this schema loads.
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .optional(),
  BETTERSTACK_SOURCE_TOKEN: z.string(),
  BETTERSTACK_INGESTING_HOST: z.string(),

  DATABASE_URL: z.string(),
  REDIS_URL: z.string(),
  CONTROL_APP_BASE_URL: z.string(),

  // Forwarded into worker pods — see .env.example WORKER POD ENV
  SESSION_WORKER_PORT: z.string(),
  PUBLIC_API_BASE_URL: z.string(),

  // k8s provisioning — control only
  SESSION_WORKER_IMAGE: z.string(),
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
