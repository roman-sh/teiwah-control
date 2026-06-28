import {
  Controller,
  Post,
  Body,
  HttpException,
  HttpStatus
} from '@nestjs/common'
import {
  FreemiusService,
  type FreemiusWebhookPayload
} from './freemius.service'

/**
 * HTTP surface for inbound Freemius webhooks.
 *
 * ROUTING: every domain owns its own controller under `/webhooks/*` (there is
 * deliberately no shared WebhooksModule). This one handles Freemius only.
 *
 * AUTH (v1): the endpoint is intentionally unauthenticated — no signature check
 * and no shared token. The security model lives in the service layer (re-fetch
 * the authoritative license from Freemius rather than trusting the body). If we
 * ever add a token it will be per-service, not a shared secret.
 *
 * MULTIPLE LISTENERS: it's expected that several Freemius dashboard listeners
 * point here (prod, dev, and a webhook.site debugging endpoint), so this handler
 * must be safe to call with the same event more than once — see the idempotent
 * binding logic in FreemiusService.
 */
@Controller('webhooks')
export class FreemiusController {
  constructor(private readonly freemiusService: FreemiusService) {}

  @Post('freemius')
  async freemius(@Body() body: FreemiusWebhookPayload) {
    log.info(
      { eventId: body.id, type: body.type, userId: body.user_id },
      'Freemius webhook received'
    )
    try {
      await this.freemiusService.handleLicenseWebhook(body)
      log.info(
        { eventId: body.id, type: body.type },
        'Freemius webhook handled'
      )
      // Freemius only needs a 2xx to consider the event delivered. The exact
      // body is irrelevant to them; `{ received: true }` is purely for humans
      // inspecting the response (e.g. via webhook.site).
      return { received: true }
    } catch (error) {
      // Return 500 so Freemius retries later. We surface a generic message and
      // keep the real error in our logs — the payload is untrusted, so we don't
      // want to echo internal details back to the caller.
      log.error(error, 'Freemius license webhook handler failed')
      throw new HttpException(
        'Handler failed',
        HttpStatus.INTERNAL_SERVER_ERROR
      )
    }
  }
}
