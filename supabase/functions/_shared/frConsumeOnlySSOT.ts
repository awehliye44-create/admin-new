/**
 * Financial Reconciliation — consume-only primary trip audit status (Slice 5).
 * FR compares stored PS / settlement / DWL / PL evidence. Never invents money.
 * Never defaults to BALANCED.
 */

export const FR_TRIP_AUDIT_STATUS = {
  BALANCED: "BALANCED",
  PARTIAL: "PARTIAL",
  CAPTURE_MISMATCH: "CAPTURE_MISMATCH",
  RELEASE_AMOUNT_UNCONFIRMED: "RELEASE_AMOUNT_UNCONFIRMED",
  MISSING_RELEASE: "MISSING_RELEASE",
  WALLET_MISMATCH: "WALLET_MISMATCH",
  PAYOUT_MISMATCH: "PAYOUT_MISMATCH",
  PROVIDER_EVIDENCE_PENDING: "PROVIDER_EVIDENCE_PENDING",
  UNAVAILABLE: "UNAVAILABLE",
  PENDING_SYNC: "PENDING_SYNC",
} as const;

export type FrTripAuditStatus =
  typeof FR_TRIP_AUDIT_STATUS[keyof typeof FR_TRIP_AUDIT_STATUS];

/**
 * Settlement identity — exact pence, no tolerance.
 * Missing capture or unknown driver_net/commission → NOT balanced (never default true).
 */
export function evaluateFrSettlementCaptureIdentity(args: {
  captured_pence: number | null | undefined;
  driver_net_pence: number | null | undefined;
  commission_pence: number | null | undefined;
  airport_charge_pence: number | null | undefined;
  tips_pence: number | null | undefined;
}): {
  balanced: boolean;
  variance_pence: number | null;
  evaluable: boolean;
} {
  if (args.captured_pence == null || Number(args.captured_pence) <= 0) {
    return { balanced: false, variance_pence: null, evaluable: false };
  }
  if (args.driver_net_pence == null || args.commission_pence == null) {
    return { balanced: false, variance_pence: null, evaluable: false };
  }
  const rhs =
    Math.max(0, Math.round(Number(args.driver_net_pence)))
    + Math.max(0, Math.round(Number(args.commission_pence)))
    + Math.max(0, Math.round(Number(args.airport_charge_pence ?? 0)))
    + Math.max(0, Math.round(Number(args.tips_pence ?? 0)));
  const variance = Math.round(Number(args.captured_pence)) - rhs;
  return { balanced: variance === 0, variance_pence: variance, evaluable: true };
}

/** Fully BALANCED only when every stream agrees — never WALLET_CREDIT_PENDING. */
export function isFrTripFullyBalanced(args: {
  capture_reconciliation_status?: string | null;
  release_reconciliation_status?: string | null;
  wallet_reconciliation_status?: string | null;
  payout_reconciliation_status?: string | null;
  fee_status?: string | null;
  settlement_identity_balanced?: boolean | null;
}): boolean {
  if (args.settlement_identity_balanced !== true) return false;
  if (args.capture_reconciliation_status !== "MATCHED") return false;
  if (args.wallet_reconciliation_status !== "WALLET_MATCHED") return false;

  const release = String(args.release_reconciliation_status ?? "");
  if (
    release
    && release !== "RELEASE_MATCHED"
    && release !== "RELEASE_NOT_REQUIRED"
  ) {
    return false;
  }

  const payout = String(args.payout_reconciliation_status ?? "");
  if (
    payout === "PAYOUT_MISMATCH"
    || payout === "PAYOUT_FAILED"
    || payout === "DUPLICATE_PAYOUT_RISK"
  ) {
    return false;
  }

  const fee = String(args.fee_status ?? "").toUpperCase();
  if (fee === "PENDING" || fee === "PENDING_PROVIDER_FEE" || fee === "UNAVAILABLE") {
    return false;
  }

  return true;
}

/**
 * Resolve first-class Slice 5 trip status. Priority: hard mismatches → pending → balanced.
 * No default BALANCED.
 */
export function resolveFrTripAuditStatus(args: {
  capture_reconciliation_status?: string | null;
  release_reconciliation_status?: string | null;
  wallet_reconciliation_status?: string | null;
  payout_reconciliation_status?: string | null;
  fee_status?: string | null;
  settlement_identity_balanced?: boolean | null;
  payment_evidence_status?: string | null;
}): FrTripAuditStatus {
  const capture = String(args.capture_reconciliation_status ?? "");
  const release = String(args.release_reconciliation_status ?? "");
  const wallet = String(args.wallet_reconciliation_status ?? "");
  const payout = String(args.payout_reconciliation_status ?? "");
  const evidence = String(args.payment_evidence_status ?? "");
  const fee = String(args.fee_status ?? "").toUpperCase();

  if (
    evidence === "PAYMENT_EVIDENCE_UNAVAILABLE"
    || capture === "PAYMENT_EVIDENCE_UNAVAILABLE"
  ) {
    return FR_TRIP_AUDIT_STATUS.UNAVAILABLE;
  }

  if (
    capture === "PAYMENT_SESSION_CAPTURE_MISMATCH"
    || capture === "CAPTURE_MISMATCH"
    || capture === "CAPTURE_SHORTFALL"
    || capture === "OVERCAPTURE"
    || capture === "CAPTURE_MISSING"
    || capture === "NO_PAYMENT_SESSION"
  ) {
    return FR_TRIP_AUDIT_STATUS.CAPTURE_MISMATCH;
  }

  if (
    wallet === "WALLET_CREDIT_MISSING"
    || wallet === "WALLET_OVER_CREDIT"
    || wallet === "WALLET_UNDER_CREDIT"
    || wallet === "DUPLICATE_WALLET_CREDIT"
  ) {
    return FR_TRIP_AUDIT_STATUS.WALLET_MISMATCH;
  }

  if (
    payout === "PAYOUT_MISMATCH"
    || payout === "PAYOUT_FAILED"
    || payout === "DUPLICATE_PAYOUT_RISK"
  ) {
    return FR_TRIP_AUDIT_STATUS.PAYOUT_MISMATCH;
  }

  if (release === "RELEASE_AMOUNT_UNCONFIRMED") {
    return FR_TRIP_AUDIT_STATUS.RELEASE_AMOUNT_UNCONFIRMED;
  }

  if (
    release === "MISSING_RELEASE"
    || release === "RELEASE_PENDING"
    || release === "RELEASE_SHORTFALL"
    || release === "RELEASE_AMOUNT_UNKNOWN"
  ) {
    return FR_TRIP_AUDIT_STATUS.MISSING_RELEASE;
  }

  if (
    capture === "PROVIDER_VERIFICATION_PENDING"
    || capture === "CAPTURE_PENDING"
    || fee === "PENDING"
    || fee === "PENDING_PROVIDER_FEE"
    || fee === "UNAVAILABLE"
  ) {
    return FR_TRIP_AUDIT_STATUS.PROVIDER_EVIDENCE_PENDING;
  }

  if (
    wallet === "WALLET_CREDIT_PENDING"
    || wallet === "WALLET_EVIDENCE_UNAVAILABLE"
    || payout === "PAYOUT_EVIDENCE_UNAVAILABLE"
    || args.settlement_identity_balanced == null
  ) {
    return FR_TRIP_AUDIT_STATUS.PENDING_SYNC;
  }

  if (isFrTripFullyBalanced(args)) {
    return FR_TRIP_AUDIT_STATUS.BALANCED;
  }

  if (args.settlement_identity_balanced === false) {
    return FR_TRIP_AUDIT_STATUS.PARTIAL;
  }

  return FR_TRIP_AUDIT_STATUS.PARTIAL;
}
