/**
 * Slice 11 — Company transfer approval, reservation & execution gate (pure SSOT).
 *
 * Extends company_outgoing_transfers. Does NOT move money.
 * LIVE_COMPANY_TRANSFER_EXECUTION_ENABLED defaults false — no Revolut /pay,
 * no source debit, no COMPLETED transfers, no driver wallet mutation.
 */

export const SLICE11 = 11 as const;

/** Canonical lifecycle statuses (backend-controlled fail-closed). */
export const COMPANY_TRANSFER_LIFECYCLE_STATUSES = [
  "DRAFT",
  "AWAITING_APPROVAL",
  "APPROVED",
  "REJECTED",
  "BLOCKED",
  "READY_FOR_EXECUTION",
  "SCHEDULED",
  "PROCESSING",
  "PAID",
  "COMPLETED",
  "FAILED",
  "DECLINED",
  "CANCELLED",
  "REVERTED",
  "FUNDING_UNAVAILABLE", // legacy alias — prefer BLOCKED
] as const;

export type CompanyTransferLifecycleStatus =
  (typeof COMPANY_TRANSFER_LIFECYCLE_STATUSES)[number];

/** Active (in-flight) statuses — duplicate create with same key returns existing. */
export const COMPANY_TRANSFER_ACTIVE_STATUSES = [
  "DRAFT",
  "AWAITING_APPROVAL",
  "APPROVED",
  "BLOCKED",
  "READY_FOR_EXECUTION",
  "SCHEDULED",
  "PROCESSING",
  "FUNDING_UNAVAILABLE",
] as const;

export const COMPANY_TRANSFER_TERMINAL_STATUSES = [
  "COMPLETED",
  "PAID",
  "CANCELLED",
  "REJECTED",
  "DECLINED",
  "REVERTED",
] as const;

export const COMPANY_TRANSFER_HISTORY_STATUSES = [
  "COMPLETED",
  "PAID",
  "FAILED",
  "REVERTED",
  "CANCELLED",
  "REJECTED",
  "DECLINED",
] as const;

/** Slice 11 approval / execution gate reason codes. */
export const COMPANY_TRANSFER_GATE_REASON = {
  OPERATIONAL_RESERVE_NOT_CONFIGURED: "OPERATIONAL_RESERVE_NOT_CONFIGURED",
  FINAL_COMPANY_FUNDS_UNAVAILABLE: "FINAL_COMPANY_FUNDS_UNAVAILABLE",
  UNCLASSIFIED_COMPANY_CASH_PRESENT: "UNCLASSIFIED_COMPANY_CASH_PRESENT",
  INSUFFICIENT_FINAL_AVAILABLE: "INSUFFICIENT_FINAL_AVAILABLE",
  PAYEE_UNVERIFIED: "PAYEE_UNVERIFIED",
  PAYEE_INACTIVE: "PAYEE_INACTIVE",
  AMOUNT_INVALID: "AMOUNT_INVALID",
  PURPOSE_REQUIRED: "PURPOSE_REQUIRED",
  CURRENCY_MISMATCH: "CURRENCY_MISMATCH",
  SERVICE_AREA_MISMATCH: "SERVICE_AREA_MISMATCH",
  DUPLICATE_ACTIVE_TRANSFER: "DUPLICATE_ACTIVE_TRANSFER",
  SELF_APPROVAL_DISABLED: "REQUESTER_CANNOT_SELF_APPROVE",
  LIVE_EXECUTION_DISABLED: "LIVE_COMPANY_TRANSFER_EXECUTION_DISABLED",
  FUNDING_SNAPSHOT_MISMATCH: "FUNDING_SNAPSHOT_MISMATCH",
  CLASSIFIED_COMPANY_CASH_UNAVAILABLE: "CLASSIFIED_COMPANY_CASH_UNAVAILABLE",
} as const;

export type CompanyTransferGateReasonCode =
  (typeof COMPANY_TRANSFER_GATE_REASON)[keyof typeof COMPANY_TRANSFER_GATE_REASON];

export const LIVE_COMPANY_TRANSFER_EXECUTION_ENV =
  "LIVE_COMPANY_TRANSFER_EXECUTION_ENABLED" as const;

/** Default false — Slice 11 safety mode. */
export function parseLiveCompanyTransferExecutionEnabled(
  envGet?: (key: string) => string | undefined | null,
): boolean {
  const read = envGet ?? (() => undefined);
  const v = String(read(LIVE_COMPANY_TRANSFER_EXECUTION_ENV) ?? "").trim().toLowerCase();
  return v === "true";
}

/** Actions that may mutate ledger cash / provider payments — blocked in Slice 11. */
export const COMPANY_TRANSFER_MONEY_MOVING_ACTIONS = new Set([
  "execute",
  "mark_paid",
  "retry",
]);

/** Non-money workflow actions allowed while LIVE_COMPANY_TRANSFER_EXECUTION_ENABLED=false. */
export const COMPANY_TRANSFER_WORKFLOW_ACTIONS = new Set([
  "create",
  "submit_for_approval",
  "approve",
  "reject",
  "cancel",
  "mark_ready_for_execution",
  "view_evidence",
]);

export type CompanyTransferFundingSnapshot = {
  captured_at: string;
  capture_phase: "APPROVAL" | "PRE_EXECUTION" | "SUBMIT";
  service_area_id: string | null;
  currency: string;
  source_balance_pence: number | null;
  protected_liabilities_pence: number | null;
  reserved_driver_payouts_pence: number | null;
  approved_payables_pence: number | null;
  classified_company_cash_pence: number | null;
  unclassified_company_cash_pence: number | null;
  unclassified_status: "RECONCILIATION_REQUIRED" | null;
  eligible_company_cash_pence: number | null;
  transferable_base_pence: number | null;
  operational_reserve_pence: number | null;
  operational_reserve_status: string | null;
  operational_reserve_reason_code: string | null;
  reserve_policy_id: string | null;
  final_company_available_pence: number | null;
  final_available_authoritative: boolean;
  source_account_id: string | null;
  rpc_versions: {
    slice10_reserve: number;
    slice11_lifecycle: number;
  };
};

export type CompanyTransferGateResult = {
  allowed: boolean;
  reason_codes: CompanyTransferGateReasonCode[];
  funding_snapshot: CompanyTransferFundingSnapshot;
};

export function computeUnclassifiedCompanyCashPence(args: {
  eligible_company_cash_pence: number | null;
  classified_company_cash_pence: number | null;
}): number | null {
  if (args.eligible_company_cash_pence == null) return null;
  if (args.classified_company_cash_pence == null) return null;
  return Math.max(
    0,
    Math.round(args.eligible_company_cash_pence) - Math.round(args.classified_company_cash_pence),
  );
}

export function buildCompanyTransferFundingSnapshot(args: {
  capture_phase: CompanyTransferFundingSnapshot["capture_phase"];
  captured_at?: string;
  service_area_id?: string | null;
  currency?: string;
  source_balance_pence?: number | null;
  protected_liabilities_pence?: number | null;
  reserved_driver_payouts_pence?: number | null;
  approved_payables_pence?: number | null;
  classified_company_cash_pence?: number | null;
  eligible_company_cash_pence?: number | null;
  transferable_base_pence?: number | null;
  operational_reserve_pence?: number | null;
  operational_reserve_status?: string | null;
  operational_reserve_reason_code?: string | null;
  reserve_policy_id?: string | null;
  final_company_available_pence?: number | null;
  source_account_id?: string | null;
}): CompanyTransferFundingSnapshot {
  const eligible = args.eligible_company_cash_pence ?? null;
  const classified = args.classified_company_cash_pence ?? null;
  const unclassified = computeUnclassifiedCompanyCashPence({
    eligible_company_cash_pence: eligible,
    classified_company_cash_pence: classified,
  });
  const finalPence = args.final_company_available_pence ?? null;
  const reserveConfigured = args.operational_reserve_pence != null
    && String(args.operational_reserve_status ?? "").toUpperCase() === "ACTIVE";

  return {
    captured_at: args.captured_at ?? new Date().toISOString(),
    capture_phase: args.capture_phase,
    service_area_id: args.service_area_id ?? null,
    currency: String(args.currency ?? "GBP").toUpperCase(),
    source_balance_pence: args.source_balance_pence ?? null,
    protected_liabilities_pence: args.protected_liabilities_pence ?? null,
    reserved_driver_payouts_pence: args.reserved_driver_payouts_pence ?? null,
    approved_payables_pence: args.approved_payables_pence ?? null,
    classified_company_cash_pence: classified,
    unclassified_company_cash_pence: unclassified,
    unclassified_status: unclassified != null && unclassified > 0
      ? "RECONCILIATION_REQUIRED"
      : null,
    eligible_company_cash_pence: eligible,
    transferable_base_pence: args.transferable_base_pence ?? null,
    operational_reserve_pence: args.operational_reserve_pence ?? null,
    operational_reserve_status: args.operational_reserve_status ?? null,
    operational_reserve_reason_code: args.operational_reserve_reason_code ?? null,
    reserve_policy_id: args.reserve_policy_id ?? null,
    final_company_available_pence: finalPence,
    final_available_authoritative: finalPence != null && reserveConfigured,
    source_account_id: args.source_account_id ?? null,
    rpc_versions: {
      slice10_reserve: 10,
      slice11_lifecycle: SLICE11,
    },
  };
}

/**
 * Approval / execution funding gate — fail-closed.
 * Unclassified cash is never used as funding. When final available is not
 * authoritative, unclassified presence is included in blocked_reason_codes
 * (Slice 11 required proof). When final is authoritative and sufficient,
 * unclassified may remain present but is unused — not a standalone block.
 */
export function evaluateCompanyTransferFundingGate(args: {
  amount_pence: number;
  funding_snapshot: CompanyTransferFundingSnapshot;
}): CompanyTransferGateResult {
  const reasons: CompanyTransferGateReasonCode[] = [];
  const snap = args.funding_snapshot;
  const amount = Math.round(Number(args.amount_pence) || 0);

  if (!(amount > 0)) {
    reasons.push(COMPANY_TRANSFER_GATE_REASON.AMOUNT_INVALID);
  }

  const reserveReason = String(snap.operational_reserve_reason_code ?? "").toUpperCase();
  const reserveActive = snap.operational_reserve_pence != null
    && String(snap.operational_reserve_status ?? "").toUpperCase() === "ACTIVE";
  if (!reserveActive || reserveReason === "OPERATIONAL_RESERVE_NOT_CONFIGURED") {
    reasons.push(COMPANY_TRANSFER_GATE_REASON.OPERATIONAL_RESERVE_NOT_CONFIGURED);
  }

  if (snap.classified_company_cash_pence == null) {
    reasons.push(COMPANY_TRANSFER_GATE_REASON.CLASSIFIED_COMPANY_CASH_UNAVAILABLE);
  }

  const finalUnavailable = !snap.final_available_authoritative
    || snap.final_company_available_pence == null;
  if (finalUnavailable) {
    reasons.push(COMPANY_TRANSFER_GATE_REASON.FINAL_COMPANY_FUNDS_UNAVAILABLE);
  } else if (amount > snap.final_company_available_pence!) {
    reasons.push(COMPANY_TRANSFER_GATE_REASON.INSUFFICIENT_FINAL_AVAILABLE);
  }

  const unclassifiedPresent = (snap.unclassified_company_cash_pence ?? 0) > 0
    || snap.unclassified_status === "RECONCILIATION_REQUIRED"
    // Fail-closed: when final is unavailable and classified funding is only a
    // fraction of provider source, unclassified / reconciliation residual is present.
    || (
      finalUnavailable
      && snap.classified_company_cash_pence != null
      && snap.source_balance_pence != null
      && snap.source_balance_pence > snap.classified_company_cash_pence
    );
  // Evidence that unclassified was not used as funding fuel while gate is closed.
  if (unclassifiedPresent && finalUnavailable) {
    reasons.push(COMPANY_TRANSFER_GATE_REASON.UNCLASSIFIED_COMPANY_CASH_PRESENT);
  }

  const unique = [...new Set(reasons)];
  return {
    allowed: unique.length === 0,
    reason_codes: unique,
    funding_snapshot: snap,
  };
}

/** READY_FOR_EXECUTION requires authoritative final available and amount ≤ final. */
export function evaluateCompanyTransferExecutionGate(args: {
  amount_pence: number;
  funding_snapshot: CompanyTransferFundingSnapshot;
  live_company_transfer_execution_enabled: boolean;
}): CompanyTransferGateResult {
  const base = evaluateCompanyTransferFundingGate({
    amount_pence: args.amount_pence,
    funding_snapshot: args.funding_snapshot,
  });
  if (!args.live_company_transfer_execution_enabled) {
    return {
      allowed: false,
      reason_codes: [
        ...base.reason_codes,
        COMPANY_TRANSFER_GATE_REASON.LIVE_EXECUTION_DISABLED,
      ].filter((v, i, a) => a.indexOf(v) === i),
      funding_snapshot: args.funding_snapshot,
    };
  }
  return base;
}

export function canTransitionCompanyTransferStatus(args: {
  from: string;
  to: string;
}): boolean {
  const from = String(args.from ?? "").toUpperCase();
  const to = String(args.to ?? "").toUpperCase();
  const allowed: Record<string, ReadonlyArray<string>> = {
    DRAFT: ["AWAITING_APPROVAL", "BLOCKED", "CANCELLED"],
    AWAITING_APPROVAL: ["APPROVED", "REJECTED", "BLOCKED", "CANCELLED"],
    APPROVED: ["READY_FOR_EXECUTION", "BLOCKED", "CANCELLED", "PROCESSING"],
    BLOCKED: ["AWAITING_APPROVAL", "CANCELLED", "APPROVED"],
    READY_FOR_EXECUTION: ["PROCESSING", "BLOCKED", "CANCELLED"],
    SCHEDULED: ["READY_FOR_EXECUTION", "PROCESSING", "BLOCKED", "CANCELLED"],
    PROCESSING: ["PAID", "COMPLETED", "FAILED", "BLOCKED"],
    FAILED: ["APPROVED", "CANCELLED"],
    FUNDING_UNAVAILABLE: ["AWAITING_APPROVAL", "CANCELLED", "BLOCKED"],
  };
  return (allowed[from] ?? []).includes(to);
}

/** Self-approval disabled by default — only enabled via explicit policy future flag. */
export function assertCompanyTransferSelfApprovalPolicy(args: {
  requester_id: string | null | undefined;
  approver_id: string | null | undefined;
  allow_self_approval?: boolean;
}): { ok: boolean; reason: string | null } {
  const requester = String(args.requester_id ?? "").trim();
  const approver = String(args.approver_id ?? "").trim();
  if (!approver) return { ok: false, reason: "APPROVER_REQUIRED" };
  if (args.allow_self_approval === true) return { ok: true, reason: null };
  if (requester && requester === approver) {
    return { ok: false, reason: COMPANY_TRANSFER_GATE_REASON.SELF_APPROVAL_DISABLED };
  }
  return { ok: true, reason: null };
}

export function isCompanyTransferMoneyMovingAction(action: string): boolean {
  return COMPANY_TRANSFER_MONEY_MOVING_ACTIONS.has(String(action ?? "").trim());
}

export function fundingSnapshotsMatchForExecution(args: {
  approval_snapshot: CompanyTransferFundingSnapshot | null | undefined;
  pre_execution_snapshot: CompanyTransferFundingSnapshot | null | undefined;
}): boolean {
  const a = args.approval_snapshot;
  const b = args.pre_execution_snapshot;
  if (!a || !b) return false;
  return a.final_company_available_pence === b.final_company_available_pence
    && a.operational_reserve_pence === b.operational_reserve_pence
    && a.classified_company_cash_pence === b.classified_company_cash_pence
    && a.source_balance_pence === b.source_balance_pence
    && a.protected_liabilities_pence === b.protected_liabilities_pence
    && String(a.currency).toUpperCase() === String(b.currency).toUpperCase()
    && String(a.service_area_id ?? "") === String(b.service_area_id ?? "");
}

/** Proven money state — do not mutate (Slice 7–10 PASS). */
export const SLICE11_PROOF = {
  SOURCE_PENCE: 1526,
  LIABILITY_PENCE: 1001,
  RESERVED_PENCE: 1001,
  BEFORE_RESERVE_PENCE: 525,
  NET_COMMISSION_PENCE: 172,
  UNCLASSIFIED_PENCE: 353,
  BOSTEYO_COMPLETED_PENCE: 408,
  SERVICE_AREA_ID_MK: "cb58f1bd-8b6f-45b9-ad31-b3140309892c",
} as const;
