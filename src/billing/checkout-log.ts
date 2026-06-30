/**
 * Sanitized Freemius overlay settings for structured logs.
 * Omits authorization tokens and other secrets from checkout.settings.
 */
export function summarizeCheckoutSettingsForLog(checkout: {
  settings?: Record<string, unknown>
}): Record<string, unknown> | null {
  const settings = checkout.settings
  if (!settings || typeof settings !== 'object') return null

  return {
    plan_id: settings.plan_id,
    license_id: settings.license_id,
    licenses: settings.licenses,
    pricing_id: settings.pricing_id,
    billing_cycle: settings.billing_cycle,
    sandbox: Boolean(settings.sandbox)
  }
}
