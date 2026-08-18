/**
 * Structured post-capture financial result.
 * Provider capture success is independent of settlement/wallet posting.
 * Never implies retry_provider_capture.
 */

export type ProviderCaptureStatus = "CAPTURED";
export type SettlementStatus = "SUCCEEDED" | "FAILED";
export type WalletPostingStatus = "SUCCEEDED" | "FAILED";
export type ReconciliationStatus = "BALANCED" | "WALLET_MISMATCH";

export type PostCaptureSettlementResult = {
  settlement_status: SettlementStatus;
  wallet_posting_status: WalletPostingStatus;
  reconciliation_status: ReconciliationStatus;
  retry_provider_capture: false;
  expected_driver_credit_pence: number;
  posted_driver_credit_pence: number;
};

export function postingBalanced(
  expectedPence: number,
  postedPence: number,
): PostCaptureSettlementResult {
  return {
    settlement_status: "SUCCEEDED",
    wallet_posting_status: "SUCCEEDED",
    reconciliation_status: "BALANCED",
    retry_provider_capture: false,
    expected_driver_credit_pence: Math.max(0, Math.round(Number(expectedPence) || 0)),
    posted_driver_credit_pence: Math.max(0, Math.round(Number(postedPence) || 0)),
  };
}

export function postingWalletMismatch(args: {
  settlement_status: SettlementStatus;
  expectedPence: number;
  postedPence: number;
}): PostCaptureSettlementResult {
  return {
    settlement_status: args.settlement_status,
    wallet_posting_status: "FAILED",
    reconciliation_status: "WALLET_MISMATCH",
    retry_provider_capture: false,
    expected_driver_credit_pence: Math.max(0, Math.round(Number(args.expectedPence) || 0)),
    posted_driver_credit_pence: Math.max(0, Math.round(Number(args.postedPence) || 0)),
  };
}

export function attachCapturedPostCaptureFields<T extends Record<string, unknown>>(
  base: T,
  posting: PostCaptureSettlementResult,
): T & {
  provider_capture_status: ProviderCaptureStatus;
  settlement_status: SettlementStatus;
  wallet_posting_status: WalletPostingStatus;
  reconciliation_status: ReconciliationStatus;
  retry_provider_capture: false;
} {
  const mismatched = posting.reconciliation_status === "WALLET_MISMATCH";
  const message = mismatched
    ? (typeof base.message === "string" && base.message.trim()
      ? base.message
      : "Wallet posting failed; provider capture remains captured")
    : base.message;
  return {
    ...base,
    ...(message != null ? { message } : {}),
    provider_capture_status: "CAPTURED",
    settlement_status: posting.settlement_status,
    wallet_posting_status: posting.wallet_posting_status,
    reconciliation_status: posting.reconciliation_status,
    retry_provider_capture: false,
  };
}
