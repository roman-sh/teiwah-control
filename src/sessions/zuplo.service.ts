import { Injectable } from '@nestjs/common'

/**
 * Zuplo Developer API — session-scoped API keys for POST /messages
 *
 * Docs: https://zuplo.com/docs/api/api-keys-consumers
 *
 * Zuplo model (relevant bits):
 *   Account  →  Key Bucket  →  Consumer  →  API Key(s)
 *
 *   - Account + bucket: Zuplo Portal → Settings → Project Information
 *   - Consumer: identity behind one or more keys; `name` must be unique in the bucket
 *   - We set consumer.name = sessionId (e.g. mighty-orca-982f)
 *
 * Send flow (n8n / curl):
 *   POST https://api.teiwah.cloud/messages
 *   Authorization: Bearer <session-api-key>
 *
 *   Zuplo API Key policy validates the key → finds the Consumer → sets user.sub = consumer.name.
 *   The /messages route handler forwards to k3s using that sub as the session id.
 *   Worker pod does not check keys — Zuplo is the bouncer.
 *
 * Control app lifecycle:
 *   create session → POST consumer (with-api-key) → return key once to dashboard/n8n
 *   delete session → DELETE consumer (keys go with it)
 */

/** Zuplo Developer API URLs (Account → Key Bucket → Consumer). */
const CONSUMERS_URL =
  `${env.ZUPLO_API_BASE}/accounts/${env.ZUPLO_ACCOUNT}/key-buckets/${env.ZUPLO_KEY_BUCKET}/consumers`

/** POST — create consumer + mint one key (key-format=visible returns full secret once). */
const CONSUMER_CREATE_URL = `${CONSUMERS_URL}?with-api-key=true&key-format=visible`

/** DELETE — consumerName path segment is Consumer.name (= sessionId), not the internal csmr_ id. */
const CONSUMER_DELETE_URL = `${CONSUMERS_URL}/{sessionId}`

/** GET — list keys for a consumer (key-format=visible returns full secret). */
const CONSUMER_KEYS_URL = `${CONSUMERS_URL}/{sessionId}/keys?key-format=visible&limit=1&offset=0`

type ZuploConsumer = {
  name: string
  apiKeys?: Array<{ key?: string }>
}

type ZuploKeysResponse = {
  data: Array<{ key?: string }>
}

@Injectable()
export class ZuploService {
  /**
   * POST /consumers?with-api-key=true&key-format=visible
   *
   * Creates a Consumer named sessionId and mints one API key in the same call.
   * key-format=visible returns the full secret once (default response masks it).
   */
  async createSessionConsumer(sessionId: string): Promise<{
    apiKey: string
    apiKeyMasked: string
  }> {
    const response = await fetch(CONSUMER_CREATE_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.ZUPLO_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: sessionId,
        description: `Teiwah session ${sessionId}`
      })
    })

    if (!response.ok) {
      const body = await response.text()
      throw new Error(
        `Zuplo create consumer failed (${response.status}): ${body}`
      )
    }

    const consumer = (await response.json()) as ZuploConsumer
    const apiKey = consumer.apiKeys?.[0]?.key

    if (!apiKey) {
      throw new Error('Zuplo create consumer succeeded but returned no API key')
    }

    log.info(`Created Zuplo consumer for session ${sessionId}`)
    return { apiKey, apiKeyMasked: maskApiKey(apiKey) }
  }

  /**
   * GET /consumers/{consumerName}/keys?key-format=visible
   */
  async getSessionConsumerApiKey(sessionId: string): Promise<string> {
    const url = CONSUMER_KEYS_URL.replace(
      '{sessionId}',
      encodeURIComponent(sessionId)
    )

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${env.ZUPLO_API_KEY}`
      }
    })

    if (response.status === 404) {
      throw new Error(`Zuplo consumer ${sessionId} not found`)
    }

    if (!response.ok) {
      const body = await response.text()
      throw new Error(
        `Zuplo list keys failed (${response.status}): ${body}`
      )
    }

    const { data } = (await response.json()) as ZuploKeysResponse
    const apiKey = data[0]?.key

    if (!apiKey) {
      throw new Error(`Zuplo consumer ${sessionId} has no API keys`)
    }

    return apiKey
  }

  /**
   * DELETE /consumers/{consumerName}
   *
   * consumerName is the Consumer's `name` field (= our sessionId), not the internal csmr_ id.
   * 404 → already deleted; treat as success.
   */
  async deleteSessionConsumer(sessionId: string): Promise<void> {
    const url = CONSUMER_DELETE_URL.replace(
      '{sessionId}',
      encodeURIComponent(sessionId)
    )

    const response = await fetch(url, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${env.ZUPLO_API_KEY}`
      }
    })

    if (response.status === 404) {
      log.warn(`Zuplo consumer ${sessionId} not found on delete`)
      return
    }

    if (!response.ok) {
      const body = await response.text()
      throw new Error(
        `Zuplo delete consumer failed (${response.status}): ${body}`
      )
    }

    log.info(`Deleted Zuplo consumer for session ${sessionId}`)
  }
}

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

/** Display-safe mask: last 8 chars only (full secret never stored). */
function maskApiKey(key: string): string {
  return key.slice(-8)
}
