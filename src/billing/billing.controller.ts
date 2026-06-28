import {
  Body,
  Controller,
  Get,
  Headers,
  HttpException,
  HttpStatus,
  Post,
  UseGuards
} from '@nestjs/common'
import { FreemiusApiError, FreemiusService } from './freemius.service'
import { UserIdHeaderGuard } from '../sessions/user-id-header.guard'

/**
 * Authenticated billing endpoints (Zuplo → x-user-id).
 *
 * Webhooks live on FreemiusController under /webhooks. This controller handles
 * dashboard-initiated checkout authorization (Subscribe / upgrade overlays).
 */
@Controller('billing')
@UseGuards(UserIdHeaderGuard)
export class BillingController {
  constructor(private readonly freemiusService: FreemiusService) {}

  /**
   * POST /billing/checkout
   *
   * License-scoped Freemius overlay settings for an existing license. The client
   * never sends license_id — we resolve it from the Clerk user → freemiusUserId
   * binding and retrievePurchases.
   *
   * Body `quota` is optional (BILLING.md §7):
   *   - omitted → convert (trial → paid at current quota)
   *   - number → upgrade to that quota (e.g. activeCount + 1 for add-quota)
   */
  @Post('checkout')
  async checkout(
    @Headers('x-user-id') userId: string,
    @Body() body: { quota?: number }
  ) {
    try {
      const checkout = await this.freemiusService.createUpgradeCheckout(
        userId,
        body.quota !== undefined ? { quota: body.quota } : undefined
      )
      return { checkout }
    } catch (error) {
      if (error instanceof HttpException) throw error
      if (error instanceof FreemiusApiError) {
        throw new HttpException(
          {
            error: 'billing_unavailable',
            message:
              'Unable to start checkout right now. Please try again shortly.'
          },
          HttpStatus.SERVICE_UNAVAILABLE
        )
      }
      log.error(error, 'Failed to create license-scoped checkout')
      throw new HttpException(
        'Failed to create checkout',
        HttpStatus.INTERNAL_SERVER_ERROR
      )
    }
  }

  /**
   * GET /billing/sandbox
   *
   * Sandbox params for the client-built new-purchase overlay. Returns
   * `{ sandbox: { ctx, token } }` outside production and `{ sandbox: null }` in
   * production, so the live overlay can never be opened in sandbox mode.
   */
  @Get('sandbox')
  async sandbox() {
    const sandbox = await this.freemiusService.getNewPurchaseSandboxParams()
    return { sandbox }
  }

  /**
   * GET /billing/portal
   *
   * Mint a fresh magic-login link to the Freemius customer portal for the
   * current user (self-serve subscription management — downgrade slots, cancel,
   * update payment). Returned to the dashboard, which opens it in a new tab.
   * The link is short-lived, so it's generated per request, never cached.
   */
  @Get('portal')
  async portal(@Headers('x-user-id') userId: string) {
    try {
      return await this.freemiusService.createCustomerPortalLink(userId)
    } catch (error) {
      if (error instanceof HttpException) throw error
      log.error(error, 'Failed to create customer portal link')
      throw new HttpException(
        'Failed to open billing portal',
        HttpStatus.INTERNAL_SERVER_ERROR
      )
    }
  }
}
