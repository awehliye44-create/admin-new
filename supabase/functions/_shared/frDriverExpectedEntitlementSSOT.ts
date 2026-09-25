/**
 * FR Drivers tab — canonical expected driver entitlement (read-only).
 *
 * Never use raw trips.driver_net_pence alone for terminal-fee outcomes.
 * Provider processing fee is platform-owned on terminal captures unless an
 * explicit approved policy says the driver pays it. Do not subtract provider
 * fee from expected driver entitlement by default.
 */

import { TERMINAL_FEE_TRIP_STATUSES } from "./driverCreditMonitoringSSOT.ts";
import { isCapturedAtRestampSuspect } from "./paymentSessionCaptureTimestampSSOT.ts";

export const FR_EXPECTED_STAMP_STATUS = {
  OK: "OK",
  EXPECTED_STAMP_MISSING: "EXPECTED_STAMP_MISSING",
} as const;

export type FrExpectedStampStatus =
  typeof FR_EXPECTED_STAMP_STATUS[keyof typeof FR_EXPECTED_STAMP_STATUS];

export type FrDriverEntitlementTripInput = {
  trip_id?: string | null;
  trip_code?: string | null;
  trip_status?: string | null;
  financial_outcome?: string | null;
  financial_model?: string | null;
  driver_net_pence?: number | null;
  commission_pence?: number | null;
  tip_pence?: number | null;
  tip_amount_pence?: number | null;
  airport_charge_pence?: number | null;
  pickup_waiting_charge_pence?: number | null;
  stop_waiting_charge_pence?: number | null;
  other_pass_through_charges_pence?: number | null;
  no_show_charge_pence?: number | null;
  /** Explicit cancel/late-cancel fee stamp when present (not lifecycle status). */
  cancellation_fee_pence?: number | null;
  late_cancel_fee_pence?: number | null;
  gross_fare_pence?: number | null;
  /** Commissionable / final fare including waiting when stamped. */
  commissionable_fare_pence?: number | null;
  final_fare_pence?: number | null;
  final_customer_fare_pence?: number | null;
  locked_base_fare_pence?: number | null;
  customer_modification_charge_pence?: number | null;
  provider_fee_pence?: number | null;
  /** driver_earning_settlement.amount_pence when present. */
  settlement_amount_pence?: number | null;
  captured_amount_pence?: number | null;
  provider_processing_fee_pence?: number | null;
  /** e.g. partial_capture_only — customer shortfall lineage, never haircuts driver expected. */
  payment_hold_status?: string | null;
  /**
   * Customer receivable lifecycle for the source trip.
   * OPEN / RESERVED / SETTLED must never alter Driver Wallet expected entitlement.
   */
  customer_receivable_status?: string | null;
  /** Count of fare TRIP_EARNING_NET rows linked to the trip (null = unknown / not loaded). */
  fare_trip_earning_net_count?: number | null;
  /** Amount on the single fare TEN when count === 1. */
  fare_trip_earning_net_pence?: number | null;
  /** True when ledger is classified as an explicit cancellation-fee credit (not fare TEN). */
  explicit_cancellation_fee_ledger?: boolean | null;
  /** Canonical financial effective instant (earned), not ledger posting. */
  financial_settled_at?: string | null;
  completed_at?: string | null;
  captured_at?: string | null;
  settlement_settled_at?: string | null;
  settlement_capture_time?: string | null;
  /** Earliest TRIP_EARNING_NET ledger posting for period-origin when capture restamped. */
  ledger_created_at?: string | null;
  /** payment_sessions.metadata.first_captured_at when present. */
  first_captured_at?: string | null;
};

/** Financial outcome class for expected entitlement — never driven by lifecycle status alone. */
export const FR_FINANCIAL_OUTCOME_CLASS = {
  FARE_SETTLEMENT: "FARE_SETTLEMENT",
  TERMINAL_FEE: "TERMINAL_FEE",
  UNKNOWN: "UNKNOWN",
} as const;

export type FrFinancialOutcomeClass =
  typeof FR_FINANCIAL_OUTCOME_CLASS[keyof typeof FR_FINANCIAL_OUTCOME_CLASS];

export type FrFinancialOutcomeClassification = {
  class: FrFinancialOutcomeClass;
  reason: string;
};

const TERMINAL_FINANCIAL_OUTCOMES = new Set([
  "NO_SHOW",
  "CANCELLED_WITH_FEE",
  "LATE_PASSENGER_CANCELLATION",
]);

function nonNegOrNull(value: unknown): number | null {
  if (value == null || !Number.isFinite(Number(value))) return null;
  return Math.max(0, Math.round(Number(value)));
}

function canonicalFarePence(trip: FrDriverEntitlementTripInput): number | null {
  return nonNegOrNull(trip.commissionable_fare_pence)
    ?? nonNegOrNull(trip.final_fare_pence)
    ?? nonNegOrNull(trip.gross_fare_pence);
}

/**
 * Canonical fare-settlement evidence (MK-017 class).
 * Lifecycle status=cancelled must not override these stamps.
 * Customer receivable OPEN/RESERVED/SETTLED is lineage only — never disqualifies fare settlement.
 */
export function hasCanonicalFareSettlementEvidence(
  trip: FrDriverEntitlementTripInput,
): boolean {
  if (trip.explicit_cancellation_fee_ledger === true) return false;

  const driverNet = nonNegOrNull(trip.driver_net_pence);
  const commission = nonNegOrNull(trip.commission_pence);
  const fare = canonicalFarePence(trip);
  const tenCount = trip.fare_trip_earning_net_count == null
    ? null
    : Math.max(0, Math.round(Number(trip.fare_trip_earning_net_count)));
  const tenPence = nonNegOrNull(trip.fare_trip_earning_net_pence);
  const hold = String(trip.payment_hold_status ?? "").trim().toLowerCase();
  const partialCaptureLineage = hold === "partial_capture_only"
    || String(trip.customer_receivable_status ?? "").trim().length > 0;

  if (driverNet == null || driverNet <= 0) return false;
  // Ambiguous multi-TEN fare credit — fail closed at classifier (UNKNOWN), not fare.
  if (tenCount != null && tenCount > 1) return false;

  if (commission != null && fare != null && fare > 0 && driverNet + commission === fare) {
    return true;
  }
  if (
    tenCount === 1
    && tenPence != null
    && tenPence === driverNet
    && commission != null
  ) {
    return true;
  }
  if (partialCaptureLineage && commission != null) {
    return true;
  }
  const status = String(trip.trip_status ?? "").trim().toLowerCase();
  if (status === "completed" && commission != null) {
    return true;
  }
  return false;
}

/** Explicit cancel/no-show fee evidence — not merely status=cancelled. */
export function hasExplicitTerminalFeeEvidence(
  trip: FrDriverEntitlementTripInput,
): boolean {
  const outcome = String(trip.financial_outcome ?? "").trim().toUpperCase();
  if (TERMINAL_FINANCIAL_OUTCOMES.has(outcome)) return true;

  const noShowFee = nonNegOrNull(trip.no_show_charge_pence) ?? 0;
  const cancelFee = nonNegOrNull(trip.cancellation_fee_pence) ?? 0;
  const lateCancelFee = nonNegOrNull(trip.late_cancel_fee_pence) ?? 0;
  if (noShowFee > 0 || cancelFee > 0 || lateCancelFee > 0) return true;

  if (trip.explicit_cancellation_fee_ledger === true) return true;

  const status = String(trip.trip_status ?? "").trim().toLowerCase();
  // no_show lifecycle is itself fee-outcome evidence; bare cancelled is not.
  if (status === "no_show") return true;

  return false;
}

/**
 * Precedence:
 * 1. Canonical fare-settlement evidence
 * 2. Explicit cancellation/no-show fee evidence
 * 3. Lifecycle status only as a weak signal → UNKNOWN (never silent zero / terminal haircut)
 * 4. Ambiguous → UNKNOWN
 */
export function classifyFrDriverFinancialOutcome(
  trip: FrDriverEntitlementTripInput,
): FrFinancialOutcomeClassification {
  if (hasCanonicalFareSettlementEvidence(trip)) {
    return {
      class: FR_FINANCIAL_OUTCOME_CLASS.FARE_SETTLEMENT,
      reason: "canonical_fare_settlement_evidence",
    };
  }
  if (hasExplicitTerminalFeeEvidence(trip)) {
    return {
      class: FR_FINANCIAL_OUTCOME_CLASS.TERMINAL_FEE,
      reason: "explicit_terminal_fee_evidence",
    };
  }
  const status = String(trip.trip_status ?? "").trim().toLowerCase();
  if (TERMINAL_FEE_TRIP_STATUSES.has(status)) {
    return {
      class: FR_FINANCIAL_OUTCOME_CLASS.UNKNOWN,
      reason: "lifecycle_status_without_financial_evidence",
    };
  }
  // Completed / other without enough stamps — still UNKNOWN until driver_net path resolves.
  if (nonNegOrNull(trip.driver_net_pence) == null && nonNegOrNull(trip.captured_amount_pence) == null) {
    return {
      class: FR_FINANCIAL_OUTCOME_CLASS.UNKNOWN,
      reason: "insufficient_financial_evidence",
    };
  }
  // Non-terminal with driver_net but incomplete fare identity — treat as fare via driver_net later.
  if (nonNegOrNull(trip.driver_net_pence) != null) {
    return {
      class: FR_FINANCIAL_OUTCOME_CLASS.FARE_SETTLEMENT,
      reason: "driver_net_stamp_without_terminal_evidence",
    };
  }
  return {
    class: FR_FINANCIAL_OUTCOME_CLASS.UNKNOWN,
    reason: "ambiguous_financial_evidence",
  };
}

export type FrTripFinancialPeriodOrigin = {
  /** Stable instant for FR period scoping — never admin-restamped captured_at alone. */
  period_origin: string | null;
  /** Back-compat alias; same as period_origin. */
  financial_settled_at: string | null;
  captured_at_restamp_suspect: boolean;
  original_trip_completed_at: string | null;
};

export type FrDriverEntitlementResolution = {
  expected_entitlement_pence: number | null;
  expected_stamp_status: FrExpectedStampStatus;
  entitlement_source: string;
  financial_settled_at: string | null;
  is_terminal_fee_outcome: boolean;
};

/**
 * True only for explicit terminal-fee financial outcomes.
 * Lifecycle status=cancelled alone is NOT sufficient (MK-017 fare settlement lock).
 */
export function isTerminalFeeFinancialOutcome(
  args: FrDriverEntitlementTripInput,
): boolean {
  return classifyFrDriverFinancialOutcome(args).class ===
    FR_FINANCIAL_OUTCOME_CLASS.TERMINAL_FEE;
}

/** Terminal capture: driver TEN = captured terminal fee − provider fee (commission 0). */
export function resolveTerminalFeeDriverTenPence(args: {
  captured_pence: number;
  provider_fee_pence: number;
  commission_pence?: number | null;
}): number {
  const captured = Math.max(0, Math.round(Number(args.captured_pence)));
  const providerFee = Math.max(0, Math.round(Number(args.provider_fee_pence)));
  const commission = Math.max(0, Math.round(Number(args.commission_pence ?? 0)));
  // Settlement / wallet credit path (legacy): capture − fee − commission.
  // FR expected entitlement uses resolveFrTerminalFeeExpectedEntitlementPence instead
  // (provider fee is platform-owned for FR credit variance).
  if (commission > 0) return Math.max(0, captured - providerFee - commission);
  return Math.max(0, captured - providerFee);
}

/**
 * FR expected entitlement for terminal-fee outcomes.
 * Provider processing fee is platform-owned — do not deduct from driver expected.
 * Matches live cancel-fee TEN practice: capture − commission (e.g. 500 − 65 = 435).
 */
export function resolveFrTerminalFeeExpectedEntitlementPence(args: {
  captured_pence: number;
  commission_pence?: number | null;
}): number {
  const captured = Math.max(0, Math.round(Number(args.captured_pence)));
  const commission = Math.max(0, Math.round(Number(args.commission_pence ?? 0)));
  return Math.max(0, captured - commission);
}

function pickFirstValidIso(candidates: (string | null | undefined)[]): string | null {
  for (const iso of candidates) {
    if (!iso?.trim()) continue;
    const ms = Date.parse(iso);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  return null;
}

/**
 * Stable FR period origin — ignores forward-restamped captured_at when ledger
 * was credited earlier (CAPTURED_AT_RESTAMP_SUSPECT).
 */
export function resolveFrTripFinancialPeriodOrigin(
  trip: Pick<
    FrDriverEntitlementTripInput,
    | "financial_settled_at"
    | "settlement_settled_at"
    | "settlement_capture_time"
    | "captured_at"
    | "completed_at"
    | "ledger_created_at"
    | "first_captured_at"
    | "trip_status"
    | "financial_outcome"
  >,
): FrTripFinancialPeriodOrigin {
  const originalTripCompletedAt = trip.completed_at?.trim()
    ? new Date(trip.completed_at).toISOString()
    : null;
  const restampSuspect = isCapturedAtRestampSuspect({
    captured_at: trip.captured_at,
    trip_completed_at: trip.completed_at,
    ledger_created_at: trip.ledger_created_at,
  });
  const capturedAtCandidate = restampSuspect ? null : trip.captured_at;
  const isTerminal = isTerminalFeeFinancialOutcome(trip);

  const periodOrigin = isTerminal
    ? pickFirstValidIso([
      trip.financial_settled_at,
      trip.settlement_capture_time,
      trip.settlement_settled_at,
      trip.first_captured_at,
      capturedAtCandidate,
      trip.completed_at,
      trip.ledger_created_at,
    ])
    : pickFirstValidIso(
      restampSuspect
        ? [
          trip.financial_settled_at,
          trip.first_captured_at,
          trip.settlement_capture_time,
          trip.settlement_settled_at,
          trip.completed_at,
          trip.ledger_created_at,
        ]
        : [
          trip.financial_settled_at,
          trip.captured_at,
          trip.settlement_capture_time,
          trip.settlement_settled_at,
          trip.completed_at,
          trip.first_captured_at,
          trip.ledger_created_at,
        ],
    );

  return {
    period_origin: periodOrigin,
    financial_settled_at: periodOrigin,
    captured_at_restamp_suspect: restampSuspect,
    original_trip_completed_at: originalTripCompletedAt,
  };
}

export function resolveFrTripFinancialSettledAt(
  trip: Pick<
    FrDriverEntitlementTripInput,
    | "financial_settled_at"
    | "settlement_settled_at"
    | "settlement_capture_time"
    | "captured_at"
    | "completed_at"
    | "ledger_created_at"
    | "first_captured_at"
    | "trip_status"
    | "financial_outcome"
  >,
): string | null {
  return resolveFrTripFinancialPeriodOrigin(trip).period_origin;
}

function tipsPence(trip: FrDriverEntitlementTripInput): number {
  const tip = trip.tip_pence ?? trip.tip_amount_pence;
  return tip == null ? 0 : Math.max(0, Math.round(Number(tip)));
}

function otherDriverEntitlementPence(trip: FrDriverEntitlementTripInput): number {
  return Math.max(0, Math.round(Number(trip.airport_charge_pence ?? 0)));
}

/**
 * Canonical FR expected driver wallet entitlement for one PLATFORM_COLLECTED trip.
 * Returns null entitlement + EXPECTED_STAMP_MISSING when authoritative stamp absent.
 *
 * Precedence (lifecycle status alone never decides):
 * 1. Canonical fare-settlement → driver_net (customer shortfall / receivable ignored)
 * 2. Explicit terminal-fee evidence → capture − commission
 * 3. UNKNOWN → fail closed (null), never silent zero
 */
export function resolveFrDriverExpectedEntitlement(
  trip: FrDriverEntitlementTripInput,
): FrDriverEntitlementResolution {
  const financialSettledAt = resolveFrTripFinancialPeriodOrigin(trip).period_origin;
  const model = String(trip.financial_model ?? "").trim().toUpperCase();
  if (model.includes("DRIVER_COLLECTED")) {
    return {
      expected_entitlement_pence: null,
      expected_stamp_status: FR_EXPECTED_STAMP_STATUS.EXPECTED_STAMP_MISSING,
      entitlement_source: "commission_wallet_not_applicable",
      financial_settled_at: financialSettledAt,
      is_terminal_fee_outcome: false,
    };
  }

  // Receivable OPEN/RESERVED/SETTLED is customer-collection lineage only — never haircuts expected.
  void trip.customer_receivable_status;

  const classification = classifyFrDriverFinancialOutcome(trip);
  const captured = trip.captured_amount_pence == null
    ? null
    : Math.max(0, Math.round(Number(trip.captured_amount_pence)));
  const commission = trip.commission_pence == null
    ? null
    : Math.max(0, Math.round(Number(trip.commission_pence)));

  if (classification.class === FR_FINANCIAL_OUTCOME_CLASS.UNKNOWN) {
    return {
      expected_entitlement_pence: null,
      expected_stamp_status: FR_EXPECTED_STAMP_STATUS.EXPECTED_STAMP_MISSING,
      entitlement_source: classification.reason,
      financial_settled_at: financialSettledAt,
      is_terminal_fee_outcome: false,
    };
  }

  // Terminal fee FR expected: capture − commission (provider fee platform-owned).
  // Requires explicit fee evidence — not status=cancelled alone.
  if (classification.class === FR_FINANCIAL_OUTCOME_CLASS.TERMINAL_FEE) {
    if (captured != null && captured > 0) {
      const terminalTen = resolveFrTerminalFeeExpectedEntitlementPence({
        captured_pence: captured,
        commission_pence: commission,
      });
      return {
        expected_entitlement_pence: terminalTen + tipsPence(trip),
        expected_stamp_status: FR_EXPECTED_STAMP_STATUS.OK,
        entitlement_source: "terminal_fee_capture_minus_commission",
        financial_settled_at: financialSettledAt,
        is_terminal_fee_outcome: true,
      };
    }
    return {
      expected_entitlement_pence: null,
      expected_stamp_status: FR_EXPECTED_STAMP_STATUS.EXPECTED_STAMP_MISSING,
      entitlement_source: "terminal_fee_capture_missing",
      financial_settled_at: financialSettledAt,
      is_terminal_fee_outcome: true,
    };
  }

  // FARE_SETTLEMENT — customer capture shortfall must not reduce driver entitlement.
  if (trip.settlement_amount_pence != null && Number.isFinite(Number(trip.settlement_amount_pence))) {
    const settlementAmt = Math.max(0, Math.round(Number(trip.settlement_amount_pence)));
    return {
      expected_entitlement_pence: settlementAmt + tipsPence(trip),
      expected_stamp_status: FR_EXPECTED_STAMP_STATUS.OK,
      entitlement_source: "driver_earning_settlement.amount_pence",
      financial_settled_at: financialSettledAt,
      is_terminal_fee_outcome: false,
    };
  }

  if (trip.driver_net_pence == null) {
    return {
      expected_entitlement_pence: null,
      expected_stamp_status: FR_EXPECTED_STAMP_STATUS.EXPECTED_STAMP_MISSING,
      entitlement_source: "driver_net_null",
      financial_settled_at: financialSettledAt,
      is_terminal_fee_outcome: false,
    };
  }

  if (trip.driver_net_pence != null && Number.isFinite(Number(trip.driver_net_pence))) {
    const net = Math.max(0, Math.round(Number(trip.driver_net_pence)));
    return {
      expected_entitlement_pence: net + tipsPence(trip) + otherDriverEntitlementPence(trip),
      expected_stamp_status: FR_EXPECTED_STAMP_STATUS.OK,
      entitlement_source: "trips.driver_net_pence",
      financial_settled_at: financialSettledAt,
      is_terminal_fee_outcome: false,
    };
  }

  return {
    expected_entitlement_pence: null,
    expected_stamp_status: FR_EXPECTED_STAMP_STATUS.EXPECTED_STAMP_MISSING,
    entitlement_source: "expected_stamp_missing",
    financial_settled_at: financialSettledAt,
    is_terminal_fee_outcome: false,
  };
}

export type FrDriverSettlementTripForReconciliation = {
  trip_id: string | null;
  driver_net_pence: number | null;
  expected_entitlement_pence?: number | null;
  expected_stamp_status?: FrExpectedStampStatus;
  financial_settled_at?: string | null;
  /** Stable FR period scoping instant (same as financial_settled_at after restamp guard). */
  period_origin?: string | null;
  captured_at_restamp_suspect?: boolean;
  original_trip_completed_at?: string | null;
  settlement_status?: string | null;
  completed_at?: string | null;
  trip_code?: string | null;
};

export function sumFrDriverExpectedEntitlementPence(
  trips: FrDriverSettlementTripForReconciliation[],
): {
  expected_payable_pence: number | null;
  missing_stamp_trip_count: number;
  evaluable_trip_count: number;
} {
  if (trips.length === 0) {
    return { expected_payable_pence: 0, missing_stamp_trip_count: 0, evaluable_trip_count: 0 };
  }
  let sum = 0;
  let missing = 0;
  let evaluable = 0;
  for (const trip of trips) {
    const explicitStatus = trip.expected_stamp_status;
    const entitlement = trip.expected_entitlement_pence ?? (
      trip.driver_net_pence == null
        ? null
        : Math.max(0, Math.round(Number(trip.driver_net_pence)))
    );
    const status = explicitStatus ?? (
      entitlement == null
        ? FR_EXPECTED_STAMP_STATUS.EXPECTED_STAMP_MISSING
        : FR_EXPECTED_STAMP_STATUS.OK
    );
    if (status === FR_EXPECTED_STAMP_STATUS.EXPECTED_STAMP_MISSING || entitlement == null) {
      missing += 1;
      continue;
    }
    evaluable += 1;
    sum += Math.max(0, Math.round(Number(entitlement)));
  }
  if (evaluable === 0 && missing > 0) {
    return { expected_payable_pence: null, missing_stamp_trip_count: missing, evaluable_trip_count: 0 };
  }
  return { expected_payable_pence: sum, missing_stamp_trip_count: missing, evaluable_trip_count: evaluable };
}

/** Map trip + session + settlement evidence → FR reconciliation row. */
function readSessionFirstCapturedAt(session: Record<string, unknown> | null): string | null {
  if (!session) return null;
  const meta = session.metadata;
  if (meta && typeof meta === "object" && !Array.isArray(meta)) {
    const fromMeta = (meta as Record<string, unknown>).first_captured_at;
    if (fromMeta != null && String(fromMeta).trim()) return String(fromMeta).trim();
  }
  return null;
}

export function buildFrDriverSettlementTripRow(args: {
  trip: Record<string, unknown>;
  session?: Record<string, unknown> | null;
  settlement?: Record<string, unknown> | null;
  /** When set, modified trips without settlement stamp may be flagged incomplete. */
  actual_wallet_trip_credit_pence?: number | null;
  /** Earliest TRIP_EARNING_NET ledger posting — restamp guard input. */
  ledger_created_at?: string | null;
  /** Count of fare TRIP_EARNING_NET rows for this trip (null = not loaded). */
  fare_trip_earning_net_count?: number | null;
  /** Amount on the single fare TEN when count === 1. */
  fare_trip_earning_net_pence?: number | null;
  /** Customer receivable status — lineage only; never alters expected entitlement. */
  customer_receivable_status?: string | null;
}): FrDriverSettlementTripForReconciliation {
  const trip = args.trip;
  const session = args.session ?? null;
  const settlement = args.settlement ?? null;
  const modCharge = Math.max(0, Math.round(Number(trip.customer_modification_charge_pence ?? 0)));
  const firstCapturedAt = readSessionFirstCapturedAt(session);
  const periodOrigin = resolveFrTripFinancialPeriodOrigin({
    trip_status: (trip.status as string | null) ?? null,
    financial_outcome: (trip.financial_outcome as string | null) ?? null,
    financial_settled_at: (trip.financial_settled_at as string | null) ?? null,
    captured_at: (session?.captured_at as string | null) ?? null,
    settlement_settled_at: (settlement?.settled_at as string | null) ?? null,
    settlement_capture_time: (settlement?.capture_time as string | null) ?? null,
    completed_at: (trip.completed_at as string | null) ?? null,
    ledger_created_at: args.ledger_created_at ?? null,
    first_captured_at: firstCapturedAt,
  });
  const resolution = resolveFrDriverExpectedEntitlement({
    trip_id: trip.id == null ? null : String(trip.id),
    trip_code: (trip.trip_code as string | null) ?? null,
    trip_status: (trip.status as string | null) ?? null,
    financial_outcome: (trip.financial_outcome as string | null) ?? null,
    financial_model: (trip.financial_model as string | null) ?? null,
    driver_net_pence: trip.driver_net_pence == null ? null : Number(trip.driver_net_pence),
    commission_pence: trip.commission_pence == null ? null : Number(trip.commission_pence),
    tip_pence: trip.tip_pence == null ? null : Number(trip.tip_pence),
    tip_amount_pence: trip.tip_amount_pence == null ? null : Number(trip.tip_amount_pence),
    airport_charge_pence: trip.airport_charge_pence == null ? null : Number(trip.airport_charge_pence),
    pickup_waiting_charge_pence: trip.pickup_waiting_charge_pence == null
      ? null
      : Number(trip.pickup_waiting_charge_pence),
    stop_waiting_charge_pence: trip.stop_waiting_charge_pence == null
      ? null
      : Number(trip.stop_waiting_charge_pence),
    other_pass_through_charges_pence: trip.other_pass_through_charges_pence == null
      ? null
      : Number(trip.other_pass_through_charges_pence),
    no_show_charge_pence: trip.no_show_charge_pence == null ? null : Number(trip.no_show_charge_pence),
    cancellation_fee_pence: trip.cancellation_fee_pence == null
      ? null
      : Number(trip.cancellation_fee_pence),
    late_cancel_fee_pence: trip.late_cancel_fee_pence == null
      ? null
      : Number(trip.late_cancel_fee_pence),
    gross_fare_pence: trip.gross_fare_pence == null ? null : Number(trip.gross_fare_pence),
    commissionable_fare_pence: trip.commissionable_fare_pence == null
      ? null
      : Number(trip.commissionable_fare_pence),
    final_fare_pence: trip.final_fare_pence == null ? null : Number(trip.final_fare_pence),
    final_customer_fare_pence: trip.final_customer_fare_pence == null
      ? null
      : Number(trip.final_customer_fare_pence),
    locked_base_fare_pence: trip.locked_base_fare_pence == null
      ? null
      : Number(trip.locked_base_fare_pence),
    customer_modification_charge_pence: trip.customer_modification_charge_pence == null
      ? null
      : Number(trip.customer_modification_charge_pence),
    provider_fee_pence: trip.provider_fee_pence == null ? null : Number(trip.provider_fee_pence),
    settlement_amount_pence: settlement?.amount_pence == null
      ? null
      : Number(settlement.amount_pence),
    captured_amount_pence: session?.captured_amount_pence == null
      ? null
      : Number(session.captured_amount_pence),
    provider_processing_fee_pence: session?.provider_processing_fee_pence == null
      ? null
      : Number(session.provider_processing_fee_pence),
    payment_hold_status: (trip.payment_hold_status as string | null) ?? null,
    customer_receivable_status: args.customer_receivable_status ?? null,
    fare_trip_earning_net_count: args.fare_trip_earning_net_count ?? null,
    fare_trip_earning_net_pence: args.fare_trip_earning_net_pence ?? (
      args.fare_trip_earning_net_count === 1 && args.actual_wallet_trip_credit_pence != null
        ? Math.round(Number(args.actual_wallet_trip_credit_pence))
        : null
    ),
    captured_at: (session?.captured_at as string | null) ?? null,
    completed_at: (trip.completed_at as string | null) ?? null,
    settlement_settled_at: (settlement?.settled_at as string | null) ?? null,
    settlement_capture_time: (settlement?.capture_time as string | null) ?? null,
    ledger_created_at: args.ledger_created_at ?? null,
    first_captured_at: firstCapturedAt,
  });
  const walletCredit = args.actual_wallet_trip_credit_pence == null
    ? null
    : Math.round(Number(args.actual_wallet_trip_credit_pence));
  const modificationStampIncomplete = modCharge > 0
    && settlement?.amount_pence == null
    && walletCredit != null
    && resolution.expected_entitlement_pence != null
    && walletCredit !== Math.round(Number(resolution.expected_entitlement_pence));
  const rowDiagnostics = {
    financial_settled_at: periodOrigin.period_origin,
    period_origin: periodOrigin.period_origin,
    captured_at_restamp_suspect: periodOrigin.captured_at_restamp_suspect,
    original_trip_completed_at: periodOrigin.original_trip_completed_at,
  };
  if (modificationStampIncomplete) {
    return {
      trip_id: trip.id == null ? null : String(trip.id),
      driver_net_pence: trip.driver_net_pence == null ? null : Number(trip.driver_net_pence),
      expected_entitlement_pence: null,
      expected_stamp_status: FR_EXPECTED_STAMP_STATUS.EXPECTED_STAMP_MISSING,
      ...rowDiagnostics,
      settlement_status: (settlement?.settlement_status as string | null) ?? null,
      completed_at: (trip.completed_at as string | null) ?? null,
      trip_code: (trip.trip_code as string | null) ?? null,
    };
  }
  return {
    trip_id: trip.id == null ? null : String(trip.id),
    driver_net_pence: trip.driver_net_pence == null ? null : Number(trip.driver_net_pence),
    expected_entitlement_pence: resolution.expected_entitlement_pence,
    expected_stamp_status: resolution.expected_stamp_status,
    ...rowDiagnostics,
    settlement_status: (settlement?.settlement_status as string | null) ?? null,
    completed_at: (trip.completed_at as string | null) ?? null,
    trip_code: (trip.trip_code as string | null) ?? null,
  };
}
