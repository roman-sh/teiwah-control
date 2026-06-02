import { z } from 'zod'

export const envSchema = z.object({
  PORT: z.string(),
  DATABASE_URL: z.string(),
  CONTROL_APP_BASE_URL: z.string(),
  SESSION_WORKER_IMAGE: z.string(),
  SESSION_WORKER_PORT: z.string(),
  IMAGE_PULL_SECRET: z.string(),
  K8S_NAMESPACE: z.string(),
  ZUPLO_API_KEY: z.string(),
  ZUPLO_ACCOUNT: z.string(),
  ZUPLO_KEY_BUCKET: z.string(),
  ZUPLO_API_BASE: z.string()
})

export type Env = z.infer<typeof envSchema>
