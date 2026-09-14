/**
 * A8B28F Stage C companion DRAFT — weeklyDriverPayoutBatchWorkflowSSOT.ts
 *
 * evaluateDriverBatchEligibility input:
 *   REPLACE payouts_enabled: boolean
 *   WITH   payout_operational_paused: boolean
 *
 * Reason mapping:
 *   if (input.payout_operational_paused) reasons.push("OPERATIONAL_PAUSE");
 *   // Keep DRIVER_PAYOUTS_DISABLED as alias in tests for one release if needed:
 *   // reasons.push("DRIVER_PAYOUTS_DISABLED") only when mapping from OP for back-compat logs
 *
 * Provider linkage checks already present (PROVIDER_LINKAGE_REQUIRED etc.) — KEEP.
 * Do not reintroduce legacy payouts_enabled.
 */

export type DriverBatchEligibilityInputStageC = {
  driver_id: string;
  wallet_balance_pence: number;
  available_payout_pence: number;
  payout_operational_paused: boolean;
  driver_held_or_blocked: boolean;
  currency: string;
  expected_currency: string;
  destination: {
    id: string;
    is_active: boolean;
    archived_at: string | null;
    provider_link_status: string | null;
    provider_counterparty_id: string | null;
    provider_recipient_account_id: string | null;
  } | null;
  has_conflicting_active_item: boolean;
};

export function evaluateDriverBatchEligibilityStageC(
  input: DriverBatchEligibilityInputStageC,
): { eligible: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const available = Math.max(0, Math.round(Number(input.available_payout_pence ?? 0)));
  const currency = String(input.currency ?? '').toUpperCase();
  const expected = String(input.expected_currency ?? 'GBP').toUpperCase();

  if (input.payout_operational_paused) reasons.push('OPERATIONAL_PAUSE');
  if (input.driver_held_or_blocked) reasons.push('DRIVER_HELD_OR_BLOCKED');
  if (available <= 0) reasons.push('AVAILABLE_PAYOUT_ZERO');
  if (currency !== expected) reasons.push('CURRENCY_MISMATCH');
  if (input.has_conflicting_active_item) reasons.push('CONFLICTING_ACTIVE_PAYOUT_ITEM');

  const dest = input.destination;
  if (!dest) {
    reasons.push('NO_ACTIVE_DESTINATION');
  } else {
    if (!dest.is_active || dest.archived_at) reasons.push('DESTINATION_INACTIVE');
    const link = String(dest.provider_link_status ?? '').toUpperCase();
    if (link !== 'PROVIDER_VERIFIED') reasons.push('PROVIDER_LINKAGE_REQUIRED');
    if (!dest.provider_counterparty_id) reasons.push('MISSING_COUNTERPARTY');
    if (!dest.provider_recipient_account_id) reasons.push('MISSING_RECIPIENT_ACCOUNT');
  }

  return { eligible: reasons.length === 0, reasons };
}
