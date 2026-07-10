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

export type PaymentSessionAmountAudit = {
  evidence_status: PaymentSessionEvidenceStatus;
  balanced: boolean;
  total_authorised_amount_pence: number | null;
  captured_amount_pence: number | null;
  released_amount_pence: number | null;
  refunded_amount_pence: number | null;
  invariants: AuditInvariantResult[];
};

export function resolveTotalAuthorisedPence(row: PaymentSessionAmountRow): number | null {
  const total = row.total_authorised_amount_pence ?? row.authorised_amount_pence ?? null;
  if (total == null || total <= 0) return null;
  return total;
}

export function deriveEvidenceStatus(row: PaymentSessionAmountRow): PaymentSessionEvidenceStatus {
  if (row.released_at && row.released_amount_pence == null) return "AMOUNT_UNCONFIRMED";
  if (row.captured_at && row.captured_amount_pence == null) return "AMOUNT_UNCONFIRMED";
  if (row.refunded_at && row.refunded_amount_pence == null) return "AMOUNT_UNCONFIRMED";
  return "OK";
}

/** Read-only audit — never used for backfill inference. */
export function auditPaymentSessionAmounts(row: PaymentSessionAmountRow): PaymentSessionAmountAudit {
  const totalAuth = resolveTotalAuthorisedPence(row);
  const captured = row.captured_amount_pence ?? null;
  const released = row.released_amount_pence ?? null;
  const refunded = row.refunded_amount_pence ?? null;
  const invariants: AuditInvariantResult[] = [];
  let balanced = true;

  const evidence_status = deriveEvidenceStatus(row);

  if (captured != null && captured < 0) balanced = false;
  if (released != null && released < 0) balanced = false;
  if (refunded != null && refunded < 0) balanced = false;

  if (refunded != null && captured != null && refunded > captured) {
    balanced = false;
    invariants.push({ code: "INV-R4", passed: false, message: "refunded exceeds captured" });
  } else {
    invariants.push({ code: "INV-R4", passed: true });
  }

  if (totalAuth != null && captured != null && released != null) {
    const sum = captured + released;
    const passed = sum === totalAuth;
    if (!passed) balanced = false;
    invariants.push({
      code: "INV-R2",
      passed,
      expected_sum_pence: totalAuth,
      actual_sum_pence: sum,
    });
  }

  if (
    totalAuth != null
    && released != null
    && (captured == null || captured === 0)
    && row.released_at
  ) {
    const passed = released === totalAuth;
    if (!passed) balanced = false;
    invariants.push({
      code: "INV-R1",
      passed,
      expected_pence: totalAuth,
      actual_pence: released,
    });
  }

  return {
    evidence_status,
    balanced,
    total_authorised_amount_pence: totalAuth,
    captured_amount_pence: captured,
    released_amount_pence: released,
    refunded_amount_pence: refunded,
    invariants,
  };
}

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

/** Validates partial capture + remainder release case (900 + 300 = 1200). */
export function validatePartialCaptureRelease(args: {
  total_authorised_amount_pence: number;
  captured_amount_pence: number;
  released_amount_pence: number;
}): boolean {
  return (
    args.captured_amount_pence >= 0
    && args.released_amount_pence >= 0
    && args.captured_amount_pence + args.released_amount_pence === args.total_authorised_amount_pence
  );
}
