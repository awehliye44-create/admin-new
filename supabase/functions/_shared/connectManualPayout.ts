/**
 * Connect-balance manual payout guards (visibility + admin-driver-connect-payout).
 * Does not replace finance SSOT driver_available_now for standard wallet payouts.
 */

export type ConnectManualPayoutGateInput = {
  wallet_balance_pence: number;
  driver_available_now_pence: number;
  /** Stripe balance.available (standard — display / settlement gap). */
  connect_available_pence: number;
  /** Stripe balance.instant_available — ONECAB execution cap. */
  connect_instant_available_pence: number;
  payouts_enabled: boolean;
  charges_enabled: boolean;
  stripe_account_id: string | null;
  account_restricted: boolean;
  payout_blocked: boolean;
  reconciliation_status: string;
  outstanding_debt_pence: number;
};

export function computeMaxManualConnectPayoutPence(
  input: ConnectManualPayoutGateInput,
): number {
  // Finance-cleared + Stripe instant only — never cap from wallet_balance liability.
  return Math.min(
    Math.max(0, input.driver_available_now_pence),
    Math.max(0, input.connect_instant_available_pence),
  );
}

export function evaluateConnectManualPayoutGate(
  input: ConnectManualPayoutGateInput,
): { allowed: boolean; max_manual_payout_pence: number; block_reasons: string[] } {
  const block_reasons: string[] = [];
  const max_manual_payout_pence = computeMaxManualConnectPayoutPence(input);

  if (!input.stripe_account_id) {
    block_reasons.push("No Stripe Connect account");
  }
  if (!input.payouts_enabled) {
    block_reasons.push("Connect payouts disabled");
  }
  if (!input.charges_enabled) {
    block_reasons.push("Connect charges not enabled");
  }
  if (input.account_restricted) {
    block_reasons.push("Stripe account restricted — requirements due");
  }
  if (input.wallet_balance_pence <= 0) {
    block_reasons.push("ONECAB wallet balance is zero or negative");
  }
  if (input.driver_available_now_pence <= 0) {
    block_reasons.push("ONECAB available now is zero (finance SSOT)");
  }
  if (input.connect_instant_available_pence <= 0) {
    block_reasons.push("Stripe Instant Available balance is zero");
  }
  if (input.payout_blocked) {
    block_reasons.push("Finance payout block active");
  }
  if (input.reconciliation_status !== "BALANCED") {
    block_reasons.push("Reconciliation mismatch — resolve before manual Connect payout");
  }
  if (input.outstanding_debt_pence > 0) {
    block_reasons.push("Outstanding cash commission debt");
  }
  if (max_manual_payout_pence <= 0) {
    block_reasons.push("Max manual payout is zero after caps");
  }

  return {
    allowed: block_reasons.length === 0,
    max_manual_payout_pence,
    block_reasons,
  };
}

export async function insertConnectPayoutAuditLog(
  supabase: { from: (table: string) => { insert: (row: Record<string, unknown>) => Promise<{ error: { message: string } | null }> } },
  row: {
    driver_id: string;
    event_type: string;
    requested_amount_pence: number | null;
    provider_balance_pence: number | null;
    provider_error_code?: string | null;
    provider_error_message?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  const { error } = await supabase.from("payout_audit_log").insert({
    driver_id: row.driver_id,
    payout_type: "connect_manual_payout",
    event_type: row.event_type,
    requested_amount_pence: row.requested_amount_pence,
    provider_balance_pence: row.provider_balance_pence,
    provider_error_code: row.provider_error_code ?? null,
    provider_error_message: row.provider_error_message ?? null,
    metadata: row.metadata ?? {},
  });
  if (error) {
    console.warn("[connect-manual-payout] payout_audit_log insert failed", error.message);
  }
}
