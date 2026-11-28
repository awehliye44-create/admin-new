/** Offline test/audit-only helpers; not part of Edge uploads. */
import { PAYOUT_ALLOCATION_EXCLUDED_TYPES, PAYOUT_ALLOCATION_EXCLUDED_PREFIXES, PAYOUT_ALLOCATION_ELIGIBLE_CREDIT_TYPES, PayoutEligibilityGateInput, PayoutEligibilityGateResult } from "../../../functions/_shared/payoutAllocationEligibilitySSOT.ts";


export function isAllocatableWalletLedgerType(type: unknown): boolean {
  const normalized = String(type ?? "").trim().toUpperCase();
  if (!normalized) return false;
  if (PAYOUT_ALLOCATION_EXCLUDED_TYPES.has(normalized)) return false;
  if (PAYOUT_ALLOCATION_EXCLUDED_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return false;
  return PAYOUT_ALLOCATION_ELIGIBLE_CREDIT_TYPES.has(normalized);
}


export function evaluatePayoutEligibilityGate(
  input: PayoutEligibilityGateInput,
): PayoutEligibilityGateResult {
  const reasons: string[] = [];
  const amount = Math.round(Number(input.amount_pence ?? 0));
  const available = Math.round(Number(input.available_balance_pence ?? 0));
  const min = Math.max(0, Math.round(Number(input.min_threshold_pence ?? 0)));
  const currency = String(input.currency ?? "").trim().toUpperCase();
  const expected = String(input.expected_currency ?? "GBP").trim().toUpperCase();

  const destinationReady = input.payout_destination_ready == null
    ? Boolean(input.connected_account)
    : Boolean(input.payout_destination_ready);

  if (amount <= 0) reasons.push("AMOUNT_NOT_POSITIVE");
  if (amount > available) reasons.push("AMOUNT_EXCEEDS_AVAILABLE_BALANCE");
  if (!destinationReady) reasons.push("PAYOUT_DESTINATION_REQUIRED");
  if (input.payouts_paused === true) reasons.push("PAYOUTS_PAUSED");
  if (amount > 0 && amount < min) reasons.push("BELOW_MIN_PAYOUT");
  if (!currency || currency !== expected) reasons.push("CURRENCY_MISMATCH");
  if (!String(input.idempotency_key ?? "").trim()) reasons.push("IDEMPOTENCY_KEY_REQUIRED");

  return {
    ok: reasons.length === 0,
    hold_status: reasons.length > 0 ? "ELIGIBILITY_HOLD" : null,
    reasons,
  };
}

export * from "../../../functions/_shared/payoutAllocationEligibilitySSOT.ts";
