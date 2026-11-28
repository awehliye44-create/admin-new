/**
 * Phase 1A Payment Sessions SSOT — pure audit invariants and action policy.
 * Mirrors SQL: audit_payment_session_amounts, payment_session_action_policy.
 */

export type PaymentSessionPurpose =
  | "RIDE_BOOKING"
  | "SAVE_CARD"
  | "PAYMENT_RECOVERY"
  | "LEGACY_EVIDENCE";

export type PaymentSessionEvidenceStatus = "OK" | "AMOUNT_UNCONFIRMED";

export type ProviderVerification = {
  verified_at: string;
  verified_by: "admin_refresh" | "webhook";
  provider_state: string;
  matches_session_provider_order_id: boolean;
};

export type PaymentSessionAmountRow = {
  total_authorised_amount_pence?: number | null;
  authorised_amount_pence?: number | null;
  captured_amount_pence?: number | null;
  released_amount_pence?: number | null;
  refunded_amount_pence?: number | null;
  captured_at?: string | null;
  released_at?: string | null;
  refunded_at?: string | null;
};

export type AuditInvariantResult = {
  code: string;
  passed: boolean;
  message?: string;
  expected_sum_pence?: number;
  actual_sum_pence?: number;
  expected_pence?: number;
  actual_pence?: number;
};

export type PaymentSessionActionPolicy = {
  can_create_trip: boolean;
  can_retry_recovery: boolean;
  can_release: boolean;
  can_capture: boolean;
  can_refund: boolean;
  can_inspect_provider: boolean;
  purpose?: PaymentSessionPurpose;
  classification?: string;
  read_only?: boolean;
  provider_verification_fresh?: boolean;
};

const ALL_FALSE: PaymentSessionActionPolicy = {
  can_create_trip: false,
  can_retry_recovery: false,
  can_release: false,
  can_capture: false,
  can_refund: false,
  can_inspect_provider: true,
};

export function isProviderVerificationFresh(
  verification: ProviderVerification | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!verification?.matches_session_provider_order_id) return false;
  const at = Date.parse(verification.verified_at);
  if (!Number.isFinite(at)) return false;
  return nowMs - at <= 15 * 60 * 1000;
}

export function paymentSessionActionPolicy(args: {
  purpose: PaymentSessionPurpose;
  status: string;
  providerVerification?: ProviderVerification | null;
  nowMs?: number;
}): PaymentSessionActionPolicy {
  const { purpose, status } = args;

  if (purpose === "LEGACY_EVIDENCE") {
    return { ...ALL_FALSE, purpose, read_only: true, classification: "C_LEGACY_EVIDENCE" };
  }

  if (purpose === "SAVE_CARD") {
    return {
      ...ALL_FALSE,
      can_release: true,
      purpose,
      classification: "D_SAVE_CARD",
    };
  }

  if (purpose === "PAYMENT_RECOVERY") {
    return {
      ...ALL_FALSE,
      can_retry_recovery: true,
      purpose,
      classification: "E_PAYMENT_RECOVERY",
    };
  }

  if (status === "orphan_authorisation" || status === "payment_orphaned") {
    return {
      ...ALL_FALSE,
      can_retry_recovery: true,
      can_release: true,
      purpose: "RIDE_BOOKING",
      classification: "B_LIVE_ORPHAN",
    };
  }

  return {
    can_create_trip: ["authorised_hold", "payment_authorised", "trip_created", "authorising"].includes(status),
    can_retry_recovery: false,
    can_release: true,
    can_capture: [
      "trip_created",
      "dispatching",
      "completed_pending_capture",
      "authorised_hold",
      "payment_authorised",
    ].includes(status),
    can_refund: ["captured", "trip_created", "completed_pending_capture"].includes(status),
    can_inspect_provider: true,
    purpose: "RIDE_BOOKING",
    classification: "A_LIVE_RIDE",
    provider_verification_fresh: isProviderVerificationFresh(args.providerVerification, args.nowMs),
  };
}

