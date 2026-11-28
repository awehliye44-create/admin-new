/** Admin presentation-only helpers; not part of Edge uploads. */
/**
 * Customer booking payment workflow SSOT — edge functions.
 * Admin UI mirrors this in src/lib/customerPaymentWorkflow.ts.
 */

import type { GatewayCheckResult } from "../../supabase/functions/_shared/paymentGatewayGuard.ts";

import { PROVIDER_NOT_IMPLEMENTED } from "../../supabase/functions/_shared/paymentGatewayGuard.ts";

import { parseServiceAreaPaymentMethodFlags } from "../../supabase/functions/_shared/paymentMethodSSOT.ts";


export function providerPayoutNotAvailableMessage(
  displayName: string | null | undefined,
  provider: string,
): string {
  const label = displayName?.trim() || provider;
  return `${label} payout setup is not available yet.`;
}
