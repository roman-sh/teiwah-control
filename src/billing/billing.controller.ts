import {
  Body,
  Controller,
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
      const checkout = await this.freemiusService.createLicenseScopedCheckout(
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
}
