/**
 * Admin Driver Wallet — Review & repair SSOT (Finance-only).
 *
 * Separates:
 * - Adjustment (proven balance difference, Admin-typed amount)
 * - Review & repair (server-calculated stamp / evidence / reconciliation)
 * - Resume payouts (operational pause only)
 *
 * Never: direct unfreeze, arbitrary stamp edit, Revolut, payout/scheduler.
 */

import {
  calculateTripSettlementFromTripRow,
  resolveCapturedTripEarningNetPence,
  tripSettlementDbColumns,
  type TripSettlementResult,
  type TripSettlementTripRow,
} from "./tripSettlement.ts";
import { FR_EXPECTED_STAMP_STATUS } from "./frDriverExpectedEntitlementSSOT.ts";

/** Feature flags — locked by adminDriverFinancialReviewRepairLock.test.ts */
export const ADMIN_REVIEW_REPAIR_ACTION_PRESENT = true;
export const EXPECTED_STAMP_REPAIR_SEPARATE_FROM_ADJUSTMENT = true;
export const REPAIR_VALUE_SERVER_CALCULATED = true;
export const NO_ARBITRARY_STAMP_EDIT = true;
export const EVIDENCE_ONLY_REPAIR_CHANGES_NO_MONEY = true;
export const WALLET_CORRECTION_APPEND_ONLY = true;
export const FALSE_FREEZE_CLEARS_BY_RECOMPUTE = true;
export const NO_DIRECT_UNFREEZE = true;
export const OPERATIONAL_PAUSE_SEPARATE = true;
export const PROVIDER_UNKNOWN_BLOCKED = true;
export const PAYOUT_IN_FLIGHT_BLOCKED = true;
export const REPAIR_IDEMPOTENT = true;
export const REPAIR_AUDIT_IMMUTABLE = true;
export const NO_PROVIDER_CALL = true;
export const NO_PAYOUT = true;
export const DRAFT_PR_ONLY = true;
export const STOPPED_FOR_REPAIR_CONTROL_APPROVAL = true;

export const DRIVER_FINANCIAL_REPAIR_CALCULATION_VERSION = "driver_financial_repair_v1";

export const DRIVER_FINANCIAL_REPAIR_ACTION = {
  RESTORE_EXPECTED_STAMP: "RESTORE_EXPECTED_STAMP",
  RECOMPUTE_RECONCILIATION: "RECOMPUTE_RECONCILIATION",
  APPEND_WALLET_CORRECTION: "APPEND_WALLET_CORRECTION",
  NO_REPAIR_PROVIDER_UNKNOWN: "NO_REPAIR_PROVIDER_UNKNOWN",
  MANUAL_REVIEW_REQUIRED: "MANUAL_REVIEW_REQUIRED",
} as const;

export type DriverFinancialRepairAction =
  typeof DRIVER_FINANCIAL_REPAIR_ACTION[keyof typeof DRIVER_FINANCIAL_REPAIR_ACTION];

export const DRIVER_FINANCIAL_REPAIR_AUDIT_EVENT = {
  PREVIEWED: "DRIVER_FINANCIAL_REPAIR_PREVIEWED",
  EXPECTED_STAMP_RESTORED: "EXPECTED_STAMP_RESTORED",
  WALLET_CORRECTION_APPENDED: "WALLET_CORRECTION_APPENDED",
  RECONCILIATION_RECOMPUTED: "RECONCILIATION_RECOMPUTED",
  FALSE_FREEZE_CLEARED: "FALSE_FREEZE_CLEARED",
  BLOCKED: "FINANCIAL_REPAIR_BLOCKED",
} as const;

export const DRIVER_FINANCIAL_REPAIR_COPY = {
  BUTTON: "Review & repair",
  CONFIRMATION:
    "Review the verified payment and trip evidence before applying this repair. This action does not send money unless an exact wallet correction is shown.",
  EVIDENCE_ONLY_RESULT: "Financial evidence restored. No wallet balance was changed.",
  WALLET_CORRECTION_RESULT:
    "An audited £X.XX correction was added. The original wallet entry was not changed.",
  FREEZE_CLEARED_RESULT:
    "Reconciliation passed. The financial hold was removed automatically.",
} as const;

export const DRIVER_FINANCIAL_REPAIR_REASON_MIN = 3;
export const DRIVER_FINANCIAL_REPAIR_REASON_MAX = 500;

export const DRIVER_FINANCIAL_REPAIR_BLOCK = {
  PROVIDER_UNKNOWN: "PROVIDER_UNKNOWN",
  PROVIDER_PROCESSING: "PROVIDER_PROCESSING",
  UNRESOLVED_CAPTURE: "UNRESOLVED_CAPTURE",
  ACTIVE_RESERVATION: "ACTIVE_RESERVATION",
  PAYOUT_IN_FLIGHT: "PAYOUT_IN_FLIGHT",
  CONFLICTING_PAYMENT_SESSION: "CONFLICTING_PAYMENT_SESSION",
  AMBIGUOUS_ENTITLEMENT: "AMBIGUOUS_ENTITLEMENT",
  CURRENCY_MISMATCH: "CURRENCY_MISMATCH",
  ALREADY_APPLIED: "ALREADY_APPLIED",
  REPAIR_PREVIEW_STALE: "REPAIR_PREVIEW_STALE",
  NON_PLATFORM_COLLECTED: "NON_PLATFORM_COLLECTED",
  TRIP_NOT_TERMINAL: "TRIP_NOT_TERMINAL",
  CONTRADICTORY_STAMPS: "CONTRADICTORY_STAMPS",
  ARBITRARY_STAMP_EDIT: "ARBITRARY_STAMP_EDIT",
  PERMISSION_DENIED: "PERMISSION_DENIED",
  REASON_INVALID: "REASON_INVALID",
  LOCK_UNAVAILABLE: "LOCK_UNAVAILABLE",
  MONETARY_CONSERVATION_VIOLATION: "MONETARY_CONSERVATION_VIOLATION",
} as const;

export type DriverFinancialRepairBlockCode =
  typeof DRIVER_FINANCIAL_REPAIR_BLOCK[keyof typeof DRIVER_FINANCIAL_REPAIR_BLOCK];

const TERMINAL_TRIP_STATUSES = new Set([
  "completed",
  "no_show",
  "cancelled_with_fee",
  "late_passenger_cancellation",
]);

const TERMINAL_PROVIDER_STATES = new Set([
  "CAPTURED",
  "COMPLETED",
  "SUCCEEDED",
  "SETTLED",
]);

const BLOCKING_PROVIDER_STATES = new Set([
  "UNKNOWN",
  "PROCESSING",
  "PENDING",
  "AUTHORISED",
  "AUTHORIZED",
  "REQUIRES_CAPTURE",
]);

const PAYOUT_IN_FLIGHT_STATUSES = new Set([
  "SUBMITTED",
  "UNKNOWN",
  "PROCESSING",
  "IN_FLIGHT",
  "PENDING_PROVIDER",
]);

export type DriverFinancialRepairVisibilityInput = {
  wallet_status?: string | null;
  driver_credit_status?: string | null;
  reconciliation_status?: string | null;
  expected_stamp_status?: string | null;
  missing_stamp_trip_count?: number | null;
  settlement_history?: Array<{
    driver_credit_health?: string | null;
    settlement_status?: string | null;
    expected_driver_credit_pence?: number | null;
    actual_driver_credit_pence?: number | null;
    driver_net_pence?: number | null;
  }> | null;
  /** Trip / FR audit labels that may include WALLET_MISMATCH / EXPECTED_STAMP_MISSING. */
  issue_statuses?: string[] | null;
};

/**
 * Show Review & repair when any repair-relevant defect exists.
 * Opening the control must never mutate.
 */
export function shouldShowDriverFinancialReviewRepair(
  input: DriverFinancialRepairVisibilityInput,
): boolean {
  const wallet = String(input.wallet_status ?? "").toUpperCase();
  if (wallet === "FROZEN") return true;

  const credit = String(input.driver_credit_status ?? "").toUpperCase();
  if (
    credit === "EXPECTED_STAMP_MISSING"
    || credit === "DRIVER_CREDIT_UNKNOWN"
    || credit === "DRIVER_UNDER_CREDITED"
    || credit === "DRIVER_OVER_CREDITED"
    || credit === "DRIVER_WALLET_MISMATCH"
  ) {
    return true;
  }

  const recon = String(input.reconciliation_status ?? "").toUpperCase();
  if (recon === "WALLET_MISMATCH" || recon === "DRIVER_WALLET_MISMATCH") return true;

  const stamp = String(input.expected_stamp_status ?? "").toUpperCase();
  if (stamp === FR_EXPECTED_STAMP_STATUS.EXPECTED_STAMP_MISSING) return true;

  if (Math.max(0, Math.round(Number(input.missing_stamp_trip_count ?? 0))) > 0) return true;

  for (const status of input.issue_statuses ?? []) {
    const s = String(status ?? "").toUpperCase();
    if (
      s === "EXPECTED_STAMP_MISSING"
      || s === "DRIVER_CREDIT_UNKNOWN"
      || s === "WALLET_MISMATCH"
      || s === "DRIVER_WALLET_MISMATCH"
    ) {
      return true;
    }
  }

  for (const row of input.settlement_history ?? []) {
    const health = String(row.driver_credit_health ?? "").toUpperCase();
    if (
      health === "MISSING"
      || health === "UNDER_CREDITED"
      || health === "OVER_CREDITED"
      || health === "EXPECTED_STAMP_MISSING"
    ) {
      return true;
    }
    const settlement = String(row.settlement_status ?? "").toUpperCase();
    if (settlement === "MISSING_LEDGER_CREDIT" || settlement.includes("MISSING")) return true;
    if (row.driver_net_pence == null && row.expected_driver_credit_pence != null) return true;
  }

  return false;
}

/** Resume payouts only when operationally paused — never for derived freeze. */
export function shouldShowResumePayoutsOnly(input: {
  payout_operational_paused?: boolean | null;
}): boolean {
  return input.payout_operational_paused === true;
}

export function validateDriverFinancialRepairReason(reason: string | null | undefined): {
  ok: boolean;
  reason?: string;
  error_code?: DriverFinancialRepairBlockCode;
} {
  const trimmed = String(reason ?? "").trim();
  if (
    trimmed.length < DRIVER_FINANCIAL_REPAIR_REASON_MIN
    || trimmed.length > DRIVER_FINANCIAL_REPAIR_REASON_MAX
  ) {
    return { ok: false, error_code: DRIVER_FINANCIAL_REPAIR_BLOCK.REASON_INVALID };
  }
  return { ok: true, reason: trimmed };
}

export type DriverFinancialRepairEvidence = {
  driver_id: string;
  driver_name?: string | null;
  driver_code?: string | null;
  trip_id: string;
  trip_code?: string | null;
  trip_status?: string | null;
  financial_model?: string | null;
  financial_outcome?: string | null;
  payment_session_id?: string | null;
  payment_session_lineage_ok?: boolean | null;
  provider_order_id?: string | null;
  provider_payment_id?: string | null;
  provider_state?: string | null;
  captured_amount_pence?: number | null;
  final_fare_pence?: number | null;
  commission_basis_pence?: number | null;
  commission_rate_percent?: number | null;
  commission_pence?: number | null;
  provider_fee_pence?: number | null;
  tip_pence?: number | null;
  airport_charge_pence?: number | null;
  existing_driver_net_pence?: number | null;
  existing_commission_pence?: number | null;
  existing_tip_pence?: number | null;
  actual_ten_credit_pence?: number | null;
  actual_tip_credit_pence?: number | null;
  currency?: string | null;
  expected_currency?: string | null;
  has_contradictory_stamps?: boolean | null;
  active_payout_reservation?: boolean | null;
  payout_intent_status?: string | null;
  already_applied_repair_token?: string | null;
  /** Forbidden: Admin-supplied stamp overrides. Always ignored. */
  admin_override_driver_net_pence?: number | null;
};

export type DriverFinancialRepairProposedStamp = {
  driver_net_pence: number;
  commission_pence: number;
  tip_pence: number;
  airport_charge_pence: number;
  final_fare_pence: number;
  commission_pct: number;
  provider_fee_pence: number | null;
  settlement_formula_version: string | null;
  columns: Record<string, number | string | null>;
};

export type DriverFinancialRepairPreview = {
  classification: DriverFinancialRepairAction;
  repair_token: string;
  preview_hash: string;
  calculation_version: string;
  driver_id: string;
  driver_name: string | null;
  driver_code: string | null;
  trip_id: string;
  trip_code: string | null;
  payment_session_id: string | null;
  provider_order_id: string | null;
  provider_payment_id: string | null;
  provider_state: string | null;
  captured_amount_pence: number | null;
  final_fare_pence: number | null;
  commission_basis_pence: number | null;
  commission_rate_percent: number | null;
  expected_driver_entitlement_pence: number | null;
  existing_trip_stamps: {
    driver_net_pence: number | null;
    commission_pence: number | null;
    tip_pence: number | null;
    airport_charge_pence: number | null;
  };
  actual_ten_credit_pence: number;
  actual_tip_credit_pence: number;
  actual_ledger_credit_pence: number;
  canonical_expected_credit_pence: number | null;
  variance_pence: number | null;
  missing_evidence_fields: string[];
  proposed_repair: {
    restore_expected_stamp: boolean;
    proposed_stamp: DriverFinancialRepairProposedStamp | null;
    /** Canonical TRIP_EARNING_NET (+ tip when also missing) to post once. */
    canonical_ten_restoration_pence: number;
    /** Residual ADMIN_WALLET_* only AFTER accounting for canonical TEN restoration. */
    append_wallet_correction_pence: number;
    /** Server-proven total wallet delta for this Apply (TEN restore + residual). */
    proven_wallet_delta_pence: number;
    recompute_reconciliation: boolean;
    wallet_money_changes: boolean;
    /** Hint only — Apply must confirm via real FR/wallet recompute. */
    freeze_should_clear_after_recompute: boolean;
  };
  block_code: DriverFinancialRepairBlockCode | null;
  block_reason: string | null;
  apply_allowed: boolean;
};

/**
 * Plan monetary paths so TEN restoration and ADMIN_WALLET residual never double-count.
 *
 * residual = proven_target − projected_balance_after_canonical_repair
 * Invariant: canonical_restoration + positive_residual ≤ proven_missing
 */
export type DriverFinancialRepairMoneyPlan = {
  proven_target_credit_pence: number;
  actual_ledger_credit_pence: number;
  proven_missing_pence: number;
  canonical_ten_restoration_pence: number;
  residual_correction_pence: number;
  proven_wallet_delta_pence: number;
};

export function planDriverFinancialRepairMoney(args: {
  expected_ten_credit_pence: number;
  expected_tip_pence: number;
  actual_ten_credit_pence: number;
  actual_tip_credit_pence: number;
}): DriverFinancialRepairMoneyPlan | {
  ok: false;
  error_code: "MONETARY_CONSERVATION_VIOLATION";
  reason: string;
} {
  const expectedTen = Math.max(0, Math.round(Number(args.expected_ten_credit_pence) || 0));
  const expectedTip = Math.max(0, Math.round(Number(args.expected_tip_pence) || 0));
  const actualTen = Math.max(0, Math.round(Number(args.actual_ten_credit_pence) || 0));
  const actualTip = Math.max(0, Math.round(Number(args.actual_tip_credit_pence) || 0));

  const provenTarget = expectedTen + expectedTip;
  const actualLedger = actualTen + actualTip;
  const provenMissing = Math.max(0, provenTarget - actualLedger);

  let canonicalTen = 0;
  if (actualTen === 0 && expectedTen > 0) {
    canonicalTen = expectedTen;
  }
  let canonicalTip = 0;
  if (canonicalTen > 0 && actualTip === 0 && expectedTip > 0) {
    canonicalTip = expectedTip;
  }

  const canonicalRestoration = canonicalTen + canonicalTip;
  const projectedAfterCanonical = actualLedger + canonicalRestoration;
  const residualCorrection = provenTarget - projectedAfterCanonical;
  const positiveResidual = residualCorrection > 0 ? residualCorrection : 0;

  if (canonicalRestoration + positiveResidual > provenMissing) {
    if (!(provenMissing === 0 && residualCorrection < 0)) {
      return {
        ok: false,
        error_code: "MONETARY_CONSERVATION_VIOLATION",
        reason:
          `canonical_restoration_pence (${canonicalRestoration}) + residual_correction_pence (${positiveResidual}) > proven_missing_pence (${provenMissing})`,
      };
    }
  }

  if (provenMissing > 0) {
    const totalPositive = canonicalRestoration + positiveResidual;
    if (totalPositive !== provenMissing) {
      return {
        ok: false,
        error_code: "MONETARY_CONSERVATION_VIOLATION",
        reason:
          `under-credit total ${totalPositive}p !== proven_missing ${provenMissing}p`,
      };
    }
  }

  return {
    proven_target_credit_pence: provenTarget,
    actual_ledger_credit_pence: actualLedger,
    proven_missing_pence: provenMissing,
    canonical_ten_restoration_pence: canonicalRestoration,
    residual_correction_pence: residualCorrection,
    proven_wallet_delta_pence: canonicalRestoration + residualCorrection,
  };
}

/** Assert monetary conservation for Apply tests / Edge guard. */
export function assertRepairMoneyConservation(args: {
  canonical_ten_restoration_pence: number;
  residual_correction_pence: number;
  proven_missing_pence: number;
}): { ok: true } | { ok: false; error_code: "MONETARY_CONSERVATION_VIOLATION"; reason: string } {
  const canonical = Math.max(0, Math.round(Number(args.canonical_ten_restoration_pence) || 0));
  const residual = Math.round(Number(args.residual_correction_pence) || 0);
  const missing = Math.max(0, Math.round(Number(args.proven_missing_pence) || 0));
  const positiveResidual = residual > 0 ? residual : 0;
  if (canonical + positiveResidual > missing && !(missing === 0 && residual < 0)) {
    return {
      ok: false,
      error_code: "MONETARY_CONSERVATION_VIOLATION",
      reason:
        `canonical_restoration_pence (${canonical}) + residual_correction_pence (${positiveResidual}) > proven_missing_pence (${missing})`,
    };
  }
  return { ok: true };
}

function nonNegInt(v: unknown): number {
  const n = Math.round(Number(v ?? 0));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function asNullableInt(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? n : null;
}

export function isTerminalTripForFinancialRepair(args: {
  trip_status?: string | null;
  financial_outcome?: string | null;
}): boolean {
  const status = String(args.trip_status ?? "").trim().toLowerCase();
  if (TERMINAL_TRIP_STATUSES.has(status)) return true;
  const outcome = String(args.financial_outcome ?? "").trim().toUpperCase();
  return (
    outcome === "NO_SHOW"
    || outcome === "CANCELLED_WITH_FEE"
    || outcome === "LATE_PASSENGER_CANCELLATION"
    || outcome === "COMPLETED"
  );
}

export function isPlatformCollectedModel(financialModel?: string | null): boolean {
  const model = String(financialModel ?? "").toUpperCase();
  if (!model) return false;
  if (model === "DRIVER_COLLECTED_COMMISSION_WALLET" || model.includes("DRIVER_COLLECTED")) {
    return false;
  }
  return model === "PLATFORM_COLLECTED" || model.includes("PLATFORM_COLLECTED");
}

export function resolveProviderRepairGate(providerState?: string | null): {
  ok: boolean;
  block_code?: DriverFinancialRepairBlockCode;
  terminal_known: boolean;
} {
  const state = String(providerState ?? "").trim().toUpperCase();
  if (!state || state === "UNKNOWN") {
    return {
      ok: false,
      block_code: DRIVER_FINANCIAL_REPAIR_BLOCK.PROVIDER_UNKNOWN,
      terminal_known: false,
    };
  }
  if (BLOCKING_PROVIDER_STATES.has(state) && !TERMINAL_PROVIDER_STATES.has(state)) {
    if (state === "PROCESSING" || state === "PENDING") {
      return {
        ok: false,
        block_code: DRIVER_FINANCIAL_REPAIR_BLOCK.PROVIDER_PROCESSING,
        terminal_known: false,
      };
    }
    return {
      ok: false,
      block_code: DRIVER_FINANCIAL_REPAIR_BLOCK.UNRESOLVED_CAPTURE,
      terminal_known: false,
    };
  }
  if (!TERMINAL_PROVIDER_STATES.has(state)) {
    return {
      ok: false,
      block_code: DRIVER_FINANCIAL_REPAIR_BLOCK.UNRESOLVED_CAPTURE,
      terminal_known: false,
    };
  }
  return { ok: true, terminal_known: true };
}

export function resolvePayoutInFlightGate(args: {
  active_payout_reservation?: boolean | null;
  payout_intent_status?: string | null;
}): { ok: boolean; block_code?: DriverFinancialRepairBlockCode } {
  if (args.active_payout_reservation === true) {
    return { ok: false, block_code: DRIVER_FINANCIAL_REPAIR_BLOCK.ACTIVE_RESERVATION };
  }
  const intent = String(args.payout_intent_status ?? "").trim().toUpperCase();
  if (intent && PAYOUT_IN_FLIGHT_STATUSES.has(intent)) {
    return { ok: false, block_code: DRIVER_FINANCIAL_REPAIR_BLOCK.PAYOUT_IN_FLIGHT };
  }
  return { ok: true };
}

/**
 * Server-only stamp calculation. Admin override fields are deliberately ignored.
 */
export function computeExpectedStampForRepair(evidence: DriverFinancialRepairEvidence): {
  ok: true;
  settlement: TripSettlementResult;
  stamp: DriverFinancialRepairProposedStamp;
  expected_credit_pence: number;
} | {
  ok: false;
  block_code: DriverFinancialRepairBlockCode;
  reason: string;
} {
  // Hard rule: Admin cannot type an arbitrary expected stamp.
  void evidence.admin_override_driver_net_pence;

  const captured = asNullableInt(evidence.captured_amount_pence);
  if (captured == null || captured <= 0) {
    return {
      ok: false,
      block_code: DRIVER_FINANCIAL_REPAIR_BLOCK.UNRESOLVED_CAPTURE,
      reason: "Provider capture amount unknown",
    };
  }

  const tripRow: TripSettlementTripRow = {
    final_fare_pence: evidence.final_fare_pence ?? captured,
    capture_amount_pence: captured,
    tip_pence: evidence.tip_pence ?? 0,
    tip_amount_pence: evidence.tip_pence ?? 0,
    airport_charge_pence: evidence.airport_charge_pence ?? 0,
    accepted_commission_percent: evidence.commission_rate_percent ?? null,
    commission_pct: evidence.commission_rate_percent ?? null,
    driver_tier_commission_percent: evidence.commission_rate_percent ?? null,
    provider_fee_pence: evidence.provider_fee_pence ?? 0,
  };

  const resolved = resolveCapturedTripEarningNetPence({
    trip: tripRow,
    captureAmountPence: captured,
    tipPence: nonNegInt(evidence.tip_pence),
  });

  if (!resolved.settlement) {
    const fallback = calculateTripSettlementFromTripRow(
      tripRow,
      nonNegInt(evidence.provider_fee_pence),
      { provider_fee_confirmed: evidence.provider_fee_pence != null },
    );
    if (!fallback) {
      return {
        ok: false,
        block_code: DRIVER_FINANCIAL_REPAIR_BLOCK.AMBIGUOUS_ENTITLEMENT,
        reason: "Commission rule / entitlement not deterministically recomputable",
      };
    }
    const columns = tripSettlementDbColumns(fallback);
    return {
      ok: true,
      settlement: fallback,
      expected_credit_pence: fallback.driver_net_pence + fallback.airport_charge_pence,
      stamp: {
        driver_net_pence: fallback.driver_net_pence,
        commission_pence: fallback.commission_pence,
        tip_pence: fallback.tips_pence,
        airport_charge_pence: fallback.airport_charge_pence,
        final_fare_pence: fallback.final_fare_pence,
        commission_pct: fallback.tier_percent_used,
        provider_fee_pence: fallback.provider_fee_confirmed ? fallback.provider_fee_pence : null,
        settlement_formula_version: fallback.formula_version,
        columns,
      },
    };
  }

  const settlement = resolved.settlement;
  const columns = tripSettlementDbColumns(settlement);
  return {
    ok: true,
    settlement,
    expected_credit_pence: resolved.driverNetPence,
    stamp: {
      driver_net_pence: settlement.driver_net_pence,
      commission_pence: settlement.commission_pence,
      tip_pence: settlement.tips_pence,
      airport_charge_pence: settlement.airport_charge_pence,
      final_fare_pence: settlement.final_fare_pence,
      commission_pct: settlement.tier_percent_used,
      provider_fee_pence: settlement.provider_fee_confirmed ? settlement.provider_fee_pence : null,
      settlement_formula_version: settlement.formula_version,
      columns,
    },
  };
}

export function listMissingEvidenceFields(evidence: DriverFinancialRepairEvidence): string[] {
  const missing: string[] = [];
  if (!evidence.trip_id) missing.push("trip_id");
  if (!isTerminalTripForFinancialRepair(evidence)) missing.push("trip_terminal");
  if (!isPlatformCollectedModel(evidence.financial_model)) missing.push("financial_model");
  if (!evidence.payment_session_id) missing.push("payment_session_id");
  if (evidence.payment_session_lineage_ok === false) missing.push("payment_session_lineage");
  if (!evidence.provider_state) missing.push("provider_state");
  if (asNullableInt(evidence.captured_amount_pence) == null) missing.push("captured_amount_pence");
  if (evidence.commission_rate_percent == null && evidence.commission_pence == null) {
    missing.push("commission_rule");
  }
  if (evidence.existing_driver_net_pence == null) missing.push("expected_stamp.driver_net_pence");
  return missing;
}

function stablePreviewPayload(args: {
  evidence: DriverFinancialRepairEvidence;
  classification: DriverFinancialRepairAction;
  stamp: DriverFinancialRepairProposedStamp | null;
  variance_pence: number | null;
  canonical_ten_restoration_pence: number;
  append_wallet_correction_pence: number;
}): Record<string, unknown> {
  return {
    calculation_version: DRIVER_FINANCIAL_REPAIR_CALCULATION_VERSION,
    classification: args.classification,
    driver_id: args.evidence.driver_id,
    trip_id: args.evidence.trip_id,
    payment_session_id: args.evidence.payment_session_id ?? null,
    provider_order_id: args.evidence.provider_order_id ?? null,
    provider_payment_id: args.evidence.provider_payment_id ?? null,
    provider_state: String(args.evidence.provider_state ?? "").toUpperCase(),
    captured_amount_pence: asNullableInt(args.evidence.captured_amount_pence),
    existing_driver_net_pence: asNullableInt(args.evidence.existing_driver_net_pence),
    actual_ten_credit_pence: nonNegInt(args.evidence.actual_ten_credit_pence),
    actual_tip_credit_pence: nonNegInt(args.evidence.actual_tip_credit_pence),
    stamp: args.stamp
      ? {
        driver_net_pence: args.stamp.driver_net_pence,
        commission_pence: args.stamp.commission_pence,
        tip_pence: args.stamp.tip_pence,
        airport_charge_pence: args.stamp.airport_charge_pence,
        final_fare_pence: args.stamp.final_fare_pence,
        commission_pct: args.stamp.commission_pct,
      }
      : null,
    variance_pence: args.variance_pence,
    canonical_ten_restoration_pence: args.canonical_ten_restoration_pence,
    append_wallet_correction_pence: args.append_wallet_correction_pence,
  };
}

/** Deterministic preview hash (no crypto dependency in Vitest/Deno unit path). */
export function hashDriverFinancialRepairPreview(
  payload: Record<string, unknown>,
): string {
  const json = JSON.stringify(payload);
  let hash = 2166136261;
  for (let i = 0; i < json.length; i += 1) {
    hash ^= json.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `rfh_${(hash >>> 0).toString(16).padStart(8, "0")}_${json.length}`;
}

export function buildDriverFinancialRepairIdempotencyKey(args: {
  repair_token: string;
  preview_hash: string;
}): string {
  return `dw_fin_repair:${args.repair_token}:${args.preview_hash}`;
}

export function buildWalletCorrectionProviderTransferId(idempotencyKey: string): string {
  const key = String(idempotencyKey).startsWith("dw_fin_repair:")
    ? String(idempotencyKey)
    : `dw_fin_repair:${idempotencyKey}`;
  return key.slice(0, 180);
}

/**
 * Pure preview builder. Never mutates. Never accepts Admin-typed stamp amounts.
 */
export function buildDriverFinancialRepairPreview(args: {
  evidence: DriverFinancialRepairEvidence;
  repair_token: string;
  derived_frozen?: boolean | null;
}): DriverFinancialRepairPreview {
  const evidence = args.evidence;
  const missing = listMissingEvidenceFields(evidence);
  const actualTen = nonNegInt(evidence.actual_ten_credit_pence);
  const actualTip = nonNegInt(evidence.actual_tip_credit_pence);
  const actualLedger = actualTen + actualTip;

  const base = {
    repair_token: args.repair_token,
    calculation_version: DRIVER_FINANCIAL_REPAIR_CALCULATION_VERSION,
    driver_id: evidence.driver_id,
    driver_name: evidence.driver_name ?? null,
    driver_code: evidence.driver_code ?? null,
    trip_id: evidence.trip_id,
    trip_code: evidence.trip_code ?? null,
    payment_session_id: evidence.payment_session_id ?? null,
    provider_order_id: evidence.provider_order_id ?? null,
    provider_payment_id: evidence.provider_payment_id ?? null,
    provider_state: evidence.provider_state ?? null,
    captured_amount_pence: asNullableInt(evidence.captured_amount_pence),
    final_fare_pence: asNullableInt(evidence.final_fare_pence),
    commission_basis_pence: asNullableInt(evidence.commission_basis_pence),
    commission_rate_percent: evidence.commission_rate_percent == null
      ? null
      : Number(evidence.commission_rate_percent),
    existing_trip_stamps: {
      driver_net_pence: asNullableInt(evidence.existing_driver_net_pence),
      commission_pence: asNullableInt(evidence.existing_commission_pence),
      tip_pence: asNullableInt(evidence.existing_tip_pence),
      airport_charge_pence: asNullableInt(evidence.airport_charge_pence),
    },
    actual_ten_credit_pence: actualTen,
    actual_tip_credit_pence: actualTip,
    actual_ledger_credit_pence: actualLedger,
    missing_evidence_fields: missing,
  };

  const blocked = (
    classification: DriverFinancialRepairAction,
    block_code: DriverFinancialRepairBlockCode,
    block_reason: string,
  ): DriverFinancialRepairPreview => {
    const payload = stablePreviewPayload({
      evidence,
      classification,
      stamp: null,
      variance_pence: null,
      canonical_ten_restoration_pence: 0,
      append_wallet_correction_pence: 0,
    });
    return {
      ...base,
      classification,
      preview_hash: hashDriverFinancialRepairPreview(payload),
      expected_driver_entitlement_pence: null,
      canonical_expected_credit_pence: null,
      variance_pence: null,
      proposed_repair: {
        restore_expected_stamp: false,
        proposed_stamp: null,
        canonical_ten_restoration_pence: 0,
        append_wallet_correction_pence: 0,
        proven_wallet_delta_pence: 0,
        recompute_reconciliation: false,
        wallet_money_changes: false,
        freeze_should_clear_after_recompute: false,
      },
      block_code,
      block_reason,
      apply_allowed: false,
    };
  };

  if (evidence.already_applied_repair_token) {
    return blocked(
      DRIVER_FINANCIAL_REPAIR_ACTION.MANUAL_REVIEW_REQUIRED,
      DRIVER_FINANCIAL_REPAIR_BLOCK.ALREADY_APPLIED,
      "Repair already applied for this token",
    );
  }

  if (
    evidence.expected_currency
    && evidence.currency
    && String(evidence.expected_currency).toUpperCase() !== String(evidence.currency).toUpperCase()
  ) {
    return blocked(
      DRIVER_FINANCIAL_REPAIR_ACTION.MANUAL_REVIEW_REQUIRED,
      DRIVER_FINANCIAL_REPAIR_BLOCK.CURRENCY_MISMATCH,
      "Currency mismatch between wallet and payment evidence",
    );
  }

  if (!isPlatformCollectedModel(evidence.financial_model)) {
    return blocked(
      DRIVER_FINANCIAL_REPAIR_ACTION.MANUAL_REVIEW_REQUIRED,
      DRIVER_FINANCIAL_REPAIR_BLOCK.NON_PLATFORM_COLLECTED,
      "PLATFORM_COLLECTED model required",
    );
  }

  if (!isTerminalTripForFinancialRepair(evidence)) {
    return blocked(
      DRIVER_FINANCIAL_REPAIR_ACTION.MANUAL_REVIEW_REQUIRED,
      DRIVER_FINANCIAL_REPAIR_BLOCK.TRIP_NOT_TERMINAL,
      "Trip is not terminal/completed",
    );
  }

  const providerGate = resolveProviderRepairGate(evidence.provider_state);
  if (!providerGate.ok) {
    const classification = providerGate.block_code === DRIVER_FINANCIAL_REPAIR_BLOCK.PROVIDER_UNKNOWN
      ? DRIVER_FINANCIAL_REPAIR_ACTION.NO_REPAIR_PROVIDER_UNKNOWN
      : DRIVER_FINANCIAL_REPAIR_ACTION.MANUAL_REVIEW_REQUIRED;
    return blocked(
      classification,
      providerGate.block_code!,
      providerGate.block_code === DRIVER_FINANCIAL_REPAIR_BLOCK.PROVIDER_UNKNOWN
        ? "Provider state UNKNOWN — repair blocked"
        : "Provider capture unresolved — repair blocked",
    );
  }

  const payoutGate = resolvePayoutInFlightGate(evidence);
  if (!payoutGate.ok) {
    return blocked(
      DRIVER_FINANCIAL_REPAIR_ACTION.MANUAL_REVIEW_REQUIRED,
      payoutGate.block_code!,
      payoutGate.block_code === DRIVER_FINANCIAL_REPAIR_BLOCK.ACTIVE_RESERVATION
        ? "Active payout reservation involves this earning"
        : "Payout intent in flight (SUBMITTED/UNKNOWN)",
    );
  }

  if (evidence.payment_session_lineage_ok === false) {
    return blocked(
      DRIVER_FINANCIAL_REPAIR_ACTION.MANUAL_REVIEW_REQUIRED,
      DRIVER_FINANCIAL_REPAIR_BLOCK.CONFLICTING_PAYMENT_SESSION,
      "Conflicting payment session lineage",
    );
  }

  if (evidence.has_contradictory_stamps === true) {
    return blocked(
      DRIVER_FINANCIAL_REPAIR_ACTION.MANUAL_REVIEW_REQUIRED,
      DRIVER_FINANCIAL_REPAIR_BLOCK.CONTRADICTORY_STAMPS,
      "Contradictory stamps present — manual review required",
    );
  }

  const stampMissing = evidence.existing_driver_net_pence == null;
  const stampCompute = computeExpectedStampForRepair(evidence);
  if (!stampCompute.ok) {
    return blocked(
      DRIVER_FINANCIAL_REPAIR_ACTION.MANUAL_REVIEW_REQUIRED,
      stampCompute.block_code,
      stampCompute.reason,
    );
  }

  const expectedTen = stampCompute.expected_credit_pence;
  const expectedTip = nonNegInt(evidence.tip_pence);
  const expectedCredit = expectedTen + expectedTip;
  const variance = expectedCredit - actualLedger;

  const moneyPlan = planDriverFinancialRepairMoney({
    expected_ten_credit_pence: expectedTen,
    expected_tip_pence: expectedTip,
    actual_ten_credit_pence: actualTen,
    actual_tip_credit_pence: actualTip,
  });
  if ("ok" in moneyPlan && moneyPlan.ok === false) {
    return blocked(
      DRIVER_FINANCIAL_REPAIR_ACTION.MANUAL_REVIEW_REQUIRED,
      DRIVER_FINANCIAL_REPAIR_BLOCK.MONETARY_CONSERVATION_VIOLATION,
      moneyPlan.reason,
    );
  }
  const plan = moneyPlan as DriverFinancialRepairMoneyPlan;

  const needsStampRestore = stampMissing;
  const needsTenRestore = plan.canonical_ten_restoration_pence > 0;
  const needsResidualCorrection = plan.residual_correction_pence !== 0;

  let classification: DriverFinancialRepairAction =
    DRIVER_FINANCIAL_REPAIR_ACTION.RECOMPUTE_RECONCILIATION;
  if (needsStampRestore) {
    classification = DRIVER_FINANCIAL_REPAIR_ACTION.RESTORE_EXPECTED_STAMP;
  } else if (needsResidualCorrection && !needsTenRestore) {
    classification = DRIVER_FINANCIAL_REPAIR_ACTION.APPEND_WALLET_CORRECTION;
  } else if (needsTenRestore) {
    classification = DRIVER_FINANCIAL_REPAIR_ACTION.RESTORE_EXPECTED_STAMP;
  }

  const walletMoneyChanges = plan.proven_wallet_delta_pence !== 0;
  // Hint only — Apply confirms via real FR/wallet snapshot recompute.
  const freezeHint = plan.proven_wallet_delta_pence === variance
    || (needsStampRestore && plan.proven_wallet_delta_pence === 0 && variance === 0)
    || (variance === 0 && needsStampRestore);

  const proposed = {
    restore_expected_stamp: needsStampRestore,
    proposed_stamp: needsStampRestore || needsTenRestore || needsResidualCorrection
      ? stampCompute.stamp
      : null,
    canonical_ten_restoration_pence: plan.canonical_ten_restoration_pence,
    append_wallet_correction_pence: plan.residual_correction_pence,
    proven_wallet_delta_pence: plan.proven_wallet_delta_pence,
    recompute_reconciliation: true,
    wallet_money_changes: walletMoneyChanges,
    freeze_should_clear_after_recompute: Boolean(freezeHint || args.derived_frozen),
  };

  const payload = stablePreviewPayload({
    evidence,
    classification,
    stamp: proposed.proposed_stamp,
    variance_pence: variance,
    canonical_ten_restoration_pence: plan.canonical_ten_restoration_pence,
    append_wallet_correction_pence: plan.residual_correction_pence,
  });

  return {
    ...base,
    classification,
    preview_hash: hashDriverFinancialRepairPreview(payload),
    expected_driver_entitlement_pence: expectedCredit,
    canonical_expected_credit_pence: expectedCredit,
    variance_pence: variance,
    missing_evidence_fields: needsStampRestore
      ? missing.filter((f) => f.startsWith("expected_stamp") || f === "commission_rule")
      : missing.filter((f) => f !== "expected_stamp.driver_net_pence"),
    proposed_repair: proposed,
    block_code: null,
    block_reason: null,
    apply_allowed: true,
  };
}

/**
 * Apply-time stale check: preview hash must still match live rows.
 */
export function assertRepairPreviewStillFresh(args: {
  stored_preview_hash: string;
  live_preview_hash: string;
}): { ok: true } | { ok: false; error_code: "REPAIR_PREVIEW_STALE" } {
  if (args.stored_preview_hash !== args.live_preview_hash) {
    return { ok: false, error_code: "REPAIR_PREVIEW_STALE" };
  }
  return { ok: true };
}

/**
 * Freeze clear only from real post-repair FR/wallet recompute — never synthetic OK.
 * Never writes wallet_status / frozen / DRIVER_CREDIT_OK directly.
 */
export function evaluateFalseFreezeClearedFromRecompute(args: {
  wallet_status?: string | null;
  driver_credit_status?: string | null;
  reconciliation_status?: string | null;
  payout_status?: string | null;
  wallet_variance_pence?: number | null;
  missing_stamp_trip_count?: number | null;
  provider_state_ok: boolean;
  active_payout_reservation?: boolean | null;
  payout_intent_in_flight?: boolean | null;
}): { clear: boolean; remaining_blockers: string[] } {
  const blockers: string[] = [];
  const credit = String(args.driver_credit_status ?? "").toUpperCase();
  const wallet = String(args.wallet_status ?? "").toUpperCase();
  const recon = String(args.reconciliation_status ?? "").toUpperCase();
  const payout = String(args.payout_status ?? "").toUpperCase();
  const variance = args.wallet_variance_pence == null
    ? null
    : Math.round(Number(args.wallet_variance_pence));
  const missingStamps = Math.max(0, Math.round(Number(args.missing_stamp_trip_count ?? 0)));

  if (!args.provider_state_ok) blockers.push("PROVIDER_AMBIGUOUS");
  if (args.active_payout_reservation === true) blockers.push("ACTIVE_RESERVATION");
  if (args.payout_intent_in_flight === true) blockers.push("PAYOUT_IN_FLIGHT");
  if (missingStamps > 0) blockers.push("EXPECTED_STAMP_MISSING");
  if (
    credit === "DRIVER_UNDER_CREDITED"
    || credit === "DRIVER_OVER_CREDITED"
    || credit === "EXPECTED_STAMP_MISSING"
    || credit === "DRIVER_CREDIT_UNKNOWN"
  ) {
    blockers.push(`CREDIT:${credit}`);
  } else if (credit !== "DRIVER_CREDIT_OK" && credit !== "OK") {
    blockers.push(credit ? `CREDIT:${credit}` : "CREDIT:UNKNOWN");
  }
  if (wallet === "FROZEN") blockers.push("WALLET_FROZEN");
  if (
    recon === "DRIVER_WALLET_MISMATCH"
    || recon === "PAYOUT_MISMATCH"
    || recon === "DRIVER_AND_PAYOUT_MISMATCH"
    || recon === "MISSING_SETTLEMENT_EVIDENCE"
    || recon === "MISSING_WALLET_EVIDENCE"
  ) {
    blockers.push(`RECON:${recon}`);
  }
  if (payout === "PAYOUT_MISMATCH") blockers.push("PAYOUT_MISMATCH");
  if (variance != null && variance !== 0) blockers.push(`VARIANCE:${variance}`);

  return { clear: blockers.length === 0, remaining_blockers: blockers };
}

/** @deprecated Prefer evaluateFalseFreezeClearedFromRecompute with live snapshot fields. */
export function shouldDerivedFreezeClearAfterRecompute(args: {
  variance_pence: number | null;
  evidence_complete: boolean;
  driver_credit_status?: string | null;
}): boolean {
  return evaluateFalseFreezeClearedFromRecompute({
    driver_credit_status: args.driver_credit_status,
    wallet_variance_pence: args.variance_pence,
    provider_state_ok: args.evidence_complete,
    missing_stamp_trip_count: args.evidence_complete ? 0 : 1,
  }).clear;
}

/** Format wallet-correction result copy with exact pounds. */
export function formatWalletCorrectionResultCopy(correctionPence: number): string {
  const pounds = (Math.abs(correctionPence) / 100).toFixed(2);
  return `An audited £${pounds} correction was added. The original wallet entry was not changed.`;
}

/** Adjustment must not claim to clear EXPECTED_STAMP_MISSING. */
export function adjustmentClearsExpectedStampMissing(): false {
  return false;
}

/** Resume payouts must not modify evidence or wallet. */
export function resumePayoutsMutatesEvidenceOrWallet(): false {
  return false;
}

/** Direct unfreeze mutations are forbidden. */
export function directUnfreezeAllowed(): false {
  return false;
}
