import type { ConnectionOptions } from 'bullmq'

/** Shared Redis connection for all BullMQ queues and workers in this app. */
export const bullmqConnection: ConnectionOptions = {
  url: env.REDIS_URL,
  // Required by BullMQ — blocking commands must not retry at the ioredis layer.
  maxRetriesPerRequest: null
}
