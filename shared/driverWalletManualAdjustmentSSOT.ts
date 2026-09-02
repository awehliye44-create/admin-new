/**
 * Driver Wallet manual admin adjustment SSOT — validation, approval planning, idempotency.
 * PLATFORM_COLLECTED Driver Wallet Ledger only; append-only ledger rows.
 */

export const DRIVER_WALLET_ADMIN_CREDIT_TYPE = "ADMIN_WALLET_CREDIT" as const;
export const DRIVER_WALLET_ADMIN_DEBIT_TYPE = "ADMIN_WALLET_DEBIT" as const;

export const DRIVER_WALLET_ADMIN_ADJUSTMENT_LEDGER_TYPES = [
  DRIVER_WALLET_ADMIN_CREDIT_TYPE,
  DRIVER_WALLET_ADMIN_DEBIT_TYPE,
] as const;

export type DriverWalletAdminAdjustmentLedgerType =
  (typeof DRIVER_WALLET_ADMIN_ADJUSTMENT_LEDGER_TYPES)[number];

export const DRIVER_WALLET_ADJUSTMENT_REASON_CATEGORIES = [
  "goodwill_credit",
  "missing_earning_correction",
  "overpayment_recovery",
  "driver_penalty",
  "cash_debt_correction",
  "other",
] as const;

export type DriverWalletAdjustmentReasonCategory =
  (typeof DRIVER_WALLET_ADJUSTMENT_REASON_CATEGORIES)[number];

export const DRIVER_WALLET_ADJUSTMENT_REASON_LABELS: Record<
  DriverWalletAdjustmentReasonCategory,
  string
> = {
  goodwill_credit: "Goodwill credit",
  missing_earning_correction: "Missing earning correction",
  overpayment_recovery: "Overpayment recovery",
  driver_penalty: "Driver penalty",
  cash_debt_correction: "Cash/debt correction",
  other: "Other",
};

export const DRIVER_WALLET_ADJUSTMENT_STATUS = {
  PENDING_APPROVAL: "PENDING_APPROVAL",
  APPLIED: "APPLIED",
  REJECTED: "REJECTED",
} as const;

export type DriverWalletAdjustmentStatus =
  (typeof DRIVER_WALLET_ADJUSTMENT_STATUS)[keyof typeof DRIVER_WALLET_ADJUSTMENT_STATUS];

/** Owner approval required at or above this magnitude (pence). Default £50. */
export const DRIVER_WALLET_ADJUSTMENT_OWNER_THRESHOLD_PENCE = 5_000;

export const DRIVER_WALLET_ADJUSTMENT_MIN_AMOUNT_PENCE = 1;
export const DRIVER_WALLET_ADJUSTMENT_MIN_NOTE_LENGTH = 10;

export const DRIVER_WALLET_ADJUSTMENT_METADATA_SOURCE = "admin_manual_adjustment";

/**
 * Production gate — set true after migrations deploy:
 * - 20260930200000_driver_wallet_admin_manual_adjustments.sql
 * - 20260930210000_company_funds_authority_hardening.sql
 */
export const DRIVER_WALLET_ADMIN_ADJUSTMENTS_DEPLOYED = false;

export function driverWalletAdminAdjustmentsDeployed(): boolean {
  return DRIVER_WALLET_ADMIN_ADJUSTMENTS_DEPLOYED;
}

export const FINANCE_WALLET_ADJUSTMENT_ROLES = new Set([
  "super_admin",
  "admin",
  "finance_manager",
]);

export function normalizeDriverWalletAdjustmentDirection(
  raw: string | null | undefined,
): "CREDIT" | "DEBIT" | null {
  const v = String(raw ?? "").trim().toLowerCase();
  if (v === "credit" || v === "credit_driver") return "CREDIT";
  if (v === "debit" || v === "debit_driver") return "DEBIT";
  return null;
}

export function normalizeDriverWalletAdjustmentReasonCategory(
  raw: string | null | undefined,
): DriverWalletAdjustmentReasonCategory | null {
  const v = String(raw ?? "").trim().toLowerCase();
  return (DRIVER_WALLET_ADJUSTMENT_REASON_CATEGORIES as readonly string[]).includes(v)
    ? (v as DriverWalletAdjustmentReasonCategory)
    : null;
}

export function ledgerTypeForDriverWalletAdjustmentDirection(
  direction: "CREDIT" | "DEBIT",
): DriverWalletAdminAdjustmentLedgerType {
  return direction === "CREDIT"
    ? DRIVER_WALLET_ADMIN_CREDIT_TYPE
    : DRIVER_WALLET_ADMIN_DEBIT_TYPE;
}

export function signedAmountPenceForDriverWalletAdjustment(
  direction: "CREDIT" | "DEBIT",
  amountPence: number,
): number {
  const magnitude = Math.max(0, Math.round(Number(amountPence) || 0));
  return direction === "CREDIT" ? magnitude : -magnitude;
}

/** Credits that increase payout-eligible available immediately (no trip capture gate). */
export function isAdminWalletAdjustmentPayoutEligible(
  direction: "CREDIT" | "DEBIT",
  category: DriverWalletAdjustmentReasonCategory,
): boolean {
  if (direction === "DEBIT") return false;
  if (category === "driver_penalty") return false;
  return true;
}

export function buildDriverWalletManualAdjustmentIdempotencyKey(
  rawKey: string | null | undefined,
): string {
  const trimmed = String(rawKey ?? "").trim();
  if (!trimmed) {
    throw new Error("idempotency_key required");
  }
  if (trimmed.startsWith("dw_manual_adj:")) {
    return trimmed.length > 180 ? (() => { throw new Error("idempotency_key too long"); })() : trimmed;
  }
  if (trimmed.length > 164) {
    throw new Error("idempotency_key too long");
  }
  return `dw_manual_adj:${trimmed}`;
}

export function buildDriverWalletManualAdjustmentLedgerMetadata(args: {
  adjustmentId: string;
  reasonCategory: DriverWalletAdjustmentReasonCategory;
  reasonNote: string;
  evidenceReference?: string | null;
  payoutEligible: boolean;
  createdByAdminId: string;
  approvedByAdminId?: string | null;
}): Record<string, unknown> {
  return {
    source: DRIVER_WALLET_ADJUSTMENT_METADATA_SOURCE,
    adjustment_id: args.adjustmentId,
    reason_category: args.reasonCategory,
    reason_category_label: DRIVER_WALLET_ADJUSTMENT_REASON_LABELS[args.reasonCategory],
    reason_note: args.reasonNote,
    evidence_reference: args.evidenceReference ?? null,
    payout_eligible: args.payoutEligible,
    created_by_admin_id: args.createdByAdminId,
    approved_by_admin_id: args.approvedByAdminId ?? null,
  };
}

export type DriverWalletManualAdjustmentValidationResult =
  | {
    ok: true;
    direction: "CREDIT" | "DEBIT";
    amountPence: number;
    reasonCategory: DriverWalletAdjustmentReasonCategory;
    reasonNote: string;
    evidenceReference: string | null;
  }
  | { ok: false; code: string; error: string };

export function validateDriverWalletManualAdjustmentInput(input: {
  direction?: string | null;
  amount_pence?: unknown;
  reason_category?: string | null;
  reason_note?: string | null;
  evidence_reference?: string | null;
}): DriverWalletManualAdjustmentValidationResult {
  const direction = normalizeDriverWalletAdjustmentDirection(input.direction);
  if (!direction) {
    return { ok: false, code: "INVALID_DIRECTION", error: "Type must be credit or debit" };
  }

  const amountPence = Math.round(Number(input.amount_pence));
  if (!Number.isFinite(amountPence) || amountPence < DRIVER_WALLET_ADJUSTMENT_MIN_AMOUNT_PENCE) {
    return {
      ok: false,
      code: "INVALID_AMOUNT",
      error: `Amount must be at least ${DRIVER_WALLET_ADJUSTMENT_MIN_AMOUNT_PENCE}p`,
    };
  }

  const reasonCategory = normalizeDriverWalletAdjustmentReasonCategory(input.reason_category);
  if (!reasonCategory) {
    return { ok: false, code: "INVALID_CATEGORY", error: "Invalid reason category" };
  }

  if (direction === "CREDIT" && reasonCategory === "driver_penalty") {
    return {
      ok: false,
      code: "CATEGORY_DIRECTION_MISMATCH",
      error: "Driver penalty must be a debit",
    };
  }
  if (direction === "DEBIT" && reasonCategory === "goodwill_credit") {
    return {
      ok: false,
      code: "CATEGORY_DIRECTION_MISMATCH",
      error: "Goodwill credit must be a credit",
    };
  }

  const reasonNote = String(input.reason_note ?? "").trim();
  if (reasonNote.length < DRIVER_WALLET_ADJUSTMENT_MIN_NOTE_LENGTH) {
    return {
      ok: false,
      code: "REASON_TOO_SHORT",
      error: `Reason note must be at least ${DRIVER_WALLET_ADJUSTMENT_MIN_NOTE_LENGTH} characters`,
    };
  }

  const evidenceReference = input.evidence_reference != null
    ? String(input.evidence_reference).trim() || null
    : null;

  return {
    ok: true,
    direction,
    amountPence,
    reasonCategory,
    reasonNote,
    evidenceReference,
  };
}

export type DriverWalletManualAdjustmentPlan = {
  signedAmountPence: number;
  ledgerType: DriverWalletAdminAdjustmentLedgerType;
  payoutEligible: boolean;
  requiresOwnerApproval: boolean;
  approvalReasonCodes: string[];
  status: DriverWalletAdjustmentStatus;
  projectedAvailableAfterPence: number;
  projectedLiveAfterPence: number;
  createsDebtPosition: boolean;
};

export function planDriverWalletManualAdjustment(args: {
  direction: "CREDIT" | "DEBIT";
  amountPence: number;
  reasonCategory: DriverWalletAdjustmentReasonCategory;
  liveBalancePence: number;
  availableBalancePence: number;
  actorIsOwner: boolean;
}): DriverWalletManualAdjustmentPlan {
  const signedAmountPence = signedAmountPenceForDriverWalletAdjustment(
    args.direction,
    args.amountPence,
  );
  const ledgerType = ledgerTypeForDriverWalletAdjustmentDirection(args.direction);
  const payoutEligible = isAdminWalletAdjustmentPayoutEligible(args.direction, args.reasonCategory);

  const approvalReasonCodes: string[] = [];
  if (args.amountPence >= DRIVER_WALLET_ADJUSTMENT_OWNER_THRESHOLD_PENCE) {
    approvalReasonCodes.push("AMOUNT_ABOVE_THRESHOLD");
  }
  if (args.direction === "DEBIT") {
    if (args.amountPence > Math.max(0, args.availableBalancePence)) {
      approvalReasonCodes.push("DEBIT_EXCEEDS_AVAILABLE");
    }
    if (args.liveBalancePence - args.amountPence < 0) {
      approvalReasonCodes.push("DEBIT_CREATES_NEGATIVE_LIVE");
    }
  }

  const requiresOwnerApproval = approvalReasonCodes.length > 0;
  const canApplyImmediately = args.actorIsOwner || !requiresOwnerApproval;
  const status = canApplyImmediately
    ? DRIVER_WALLET_ADJUSTMENT_STATUS.APPLIED
    : DRIVER_WALLET_ADJUSTMENT_STATUS.PENDING_APPROVAL;

  const projectedLiveAfterPence = args.liveBalancePence + signedAmountPence;
  let projectedAvailableAfterPence = args.availableBalancePence;
  if (args.direction === "CREDIT" && payoutEligible) {
    projectedAvailableAfterPence += args.amountPence;
  } else if (args.direction === "DEBIT") {
    projectedAvailableAfterPence = Math.max(0, args.availableBalancePence - args.amountPence);
  }

  return {
    signedAmountPence,
    ledgerType,
    payoutEligible,
    requiresOwnerApproval,
    approvalReasonCodes,
    status,
    projectedAvailableAfterPence,
    projectedLiveAfterPence,
    createsDebtPosition: projectedLiveAfterPence < 0,
  };
}

export function driverWalletAdjustmentDriverTitle(
  direction: "CREDIT" | "DEBIT",
): string {
  return direction === "CREDIT" ? "Admin credit" : "Admin debit";
}

export function driverWalletAdjustmentDriverSubtitle(
  category: DriverWalletAdjustmentReasonCategory,
  note: string,
): string {
  const label = DRIVER_WALLET_ADJUSTMENT_REASON_LABELS[category];
  const shortNote = note.length > 80 ? `${note.slice(0, 77)}…` : note;
  return `${label} · ${shortNote}`;
}

export function isDriverWalletAdminAdjustmentLedgerType(
  type: string | null | undefined,
): boolean {
  const t = String(type ?? "").toUpperCase();
  return t === DRIVER_WALLET_ADMIN_CREDIT_TYPE || t === DRIVER_WALLET_ADMIN_DEBIT_TYPE;
}

export function parseDriverWalletAdminAdjustmentMetadata(
  metadata: Record<string, unknown> | null | undefined,
): {
  reasonCategory: DriverWalletAdjustmentReasonCategory | null;
  reasonCategoryLabel: string | null;
  reasonNote: string | null;
  evidenceReference: string | null;
  createdByAdminId: string | null;
  approvedByAdminId: string | null;
  payoutEligible: boolean | null;
} {
  const raw = metadata ?? {};
  const reasonCategory = normalizeDriverWalletAdjustmentReasonCategory(
    raw.reason_category != null ? String(raw.reason_category) : null,
  );
  return {
    reasonCategory,
    reasonCategoryLabel: reasonCategory
      ? DRIVER_WALLET_ADJUSTMENT_REASON_LABELS[reasonCategory]
      : (raw.reason_category_label != null ? String(raw.reason_category_label) : null),
    reasonNote: raw.reason_note != null ? String(raw.reason_note) : null,
    evidenceReference: raw.evidence_reference != null ? String(raw.evidence_reference) : null,
    createdByAdminId: raw.created_by_admin_id != null ? String(raw.created_by_admin_id) : null,
    approvedByAdminId: raw.approved_by_admin_id != null ? String(raw.approved_by_admin_id) : null,
    payoutEligible: raw.payout_eligible === true
      ? true
      : raw.payout_eligible === false
      ? false
      : null,
  };
}

export function formatDriverWalletAdminIdShort(adminId: string | null | undefined): string {
  const id = String(adminId ?? "").trim();
  if (!id) return "—";
  return `${id.slice(0, 8)}…`;
}

export function formatDriverWalletAdminAdjustmentAuditNotes(args: {
  reasonCategoryLabel?: string | null;
  reasonNote?: string | null;
  createdByAdminId?: string | null;
  approvedByAdminId?: string | null;
}): string {
  const parts: string[] = [];
  if (args.reasonCategoryLabel) parts.push(args.reasonCategoryLabel);
  if (args.reasonNote) parts.push(args.reasonNote);
  const audit: string[] = [];
  if (args.createdByAdminId) {
    audit.push(`Created ${formatDriverWalletAdminIdShort(args.createdByAdminId)}`);
  }
  if (args.approvedByAdminId) {
    audit.push(`Approved ${formatDriverWalletAdminIdShort(args.approvedByAdminId)}`);
  }
  if (audit.length) parts.push(audit.join(" · "));
  return parts.join(" · ") || "—";
}
