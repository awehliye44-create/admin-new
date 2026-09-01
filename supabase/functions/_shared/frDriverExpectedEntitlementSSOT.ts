/**
 * FR Drivers tab — canonical expected driver entitlement (read-only).
 *
 * Never use raw trips.driver_net_pence alone for terminal-fee outcomes.
 * Provider processing fee is platform-owned on terminal captures unless policy says otherwise.
 */

import { TERMINAL_FEE_TRIP_STATUSES } from "./driverCreditMonitoringSSOT.ts";
import {
  resolveCapturedTripEarningNetPence,
  type TripSettlementTripRow,
} from "./tripSettlement.ts";

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
  gross_fare_pence?: number | null;
  final_customer_fare_pence?: number | null;
  locked_base_fare_pence?: number | null;
  customer_modification_charge_pence?: number | null;
  provider_fee_pence?: number | null;
  /** driver_earning_settlement.amount_pence when present. */
  settlement_amount_pence?: number | null;
  captured_amount_pence?: number | null;
  provider_processing_fee_pence?: number | null;
  /** Canonical financial effective instant (earned), not ledger posting. */
  financial_settled_at?: string | null;
  completed_at?: string | null;
  captured_at?: string | null;
  settlement_settled_at?: string | null;
  settlement_capture_time?: string | null;
};

export type FrDriverEntitlementResolution = {
  expected_entitlement_pence: number | null;
  expected_stamp_status: FrExpectedStampStatus;
  entitlement_source: string;
  financial_settled_at: string | null;
  is_terminal_fee_outcome: boolean;
};

const TERMINAL_FINANCIAL_OUTCOMES = new Set([
  "NO_SHOW",
  "CANCELLED_WITH_FEE",
  "LATE_PASSENGER_CANCELLATION",
]);

export function isTerminalFeeFinancialOutcome(args: {
  financial_outcome?: string | null;
  trip_status?: string | null;
}): boolean {
  const outcome = String(args.financial_outcome ?? "").trim().toUpperCase();
  if (TERMINAL_FINANCIAL_OUTCOMES.has(outcome)) return true;
  const status = String(args.trip_status ?? "").trim().toLowerCase();
  return TERMINAL_FEE_TRIP_STATUSES.has(status);
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
  if (commission > 0) return Math.max(0, captured - providerFee - commission);
  return Math.max(0, captured - providerFee);
}

export function resolveFrTripFinancialSettledAt(
  trip: Pick<
    FrDriverEntitlementTripInput,
    | "financial_settled_at"
    | "settlement_settled_at"
    | "settlement_capture_time"
    | "captured_at"
    | "completed_at"
  >,
): string | null {
  const candidates = [
    trip.financial_settled_at,
    trip.captured_at,
    trip.settlement_capture_time,
    trip.settlement_settled_at,
    trip.completed_at,
  ];
  for (const iso of candidates) {
    if (!iso?.trim()) continue;
    const ms = Date.parse(iso);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  return null;
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
 */
export function resolveFrDriverExpectedEntitlement(
  trip: FrDriverEntitlementTripInput,
): FrDriverEntitlementResolution {
  const financialSettledAt = resolveFrTripFinancialSettledAt(trip);
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

  if (trip.settlement_amount_pence != null && Number.isFinite(Number(trip.settlement_amount_pence))) {
    const settlementAmt = Math.max(0, Math.round(Number(trip.settlement_amount_pence)));
    return {
      expected_entitlement_pence: settlementAmt + tipsPence(trip),
      expected_stamp_status: FR_EXPECTED_STAMP_STATUS.OK,
      entitlement_source: "driver_earning_settlement.amount_pence",
      financial_settled_at: financialSettledAt,
      is_terminal_fee_outcome: isTerminalFeeFinancialOutcome(trip),
    };
  }

  const isTerminal = isTerminalFeeFinancialOutcome(trip);
  const captured = trip.captured_amount_pence == null
    ? null
    : Math.max(0, Math.round(Number(trip.captured_amount_pence)));
  const providerFee = Math.max(
    0,
    Math.round(Number(trip.provider_processing_fee_pence ?? trip.provider_fee_pence ?? 0)),
  );
  const commission = trip.commission_pence == null
    ? null
    : Math.max(0, Math.round(Number(trip.commission_pence)));

  if (isTerminal && captured != null && captured > 0) {
    const terminalTen = resolveTerminalFeeDriverTenPence({
      captured_pence: captured,
      provider_fee_pence: providerFee,
      commission_pence: commission,
    });
    return {
      expected_entitlement_pence: terminalTen + tipsPence(trip),
      expected_stamp_status: FR_EXPECTED_STAMP_STATUS.OK,
      entitlement_source: "terminal_fee_capture_minus_provider_fee",
      financial_settled_at: financialSettledAt,
      is_terminal_fee_outcome: true,
    };
  }

  const modCharge = Math.max(0, Math.round(Number(trip.customer_modification_charge_pence ?? 0)));
  if (trip.driver_net_pence == null) {
    return {
      expected_entitlement_pence: null,
      expected_stamp_status: FR_EXPECTED_STAMP_STATUS.EXPECTED_STAMP_MISSING,
      entitlement_source: "driver_net_null",
      financial_settled_at: financialSettledAt,
      is_terminal_fee_outcome: false,
    };
  }

  if (modCharge > 0 && trip.settlement_amount_pence == null) {
    return {
      expected_entitlement_pence: null,
      expected_stamp_status: FR_EXPECTED_STAMP_STATUS.EXPECTED_STAMP_MISSING,
      entitlement_source: "modification_stamp_incomplete",
      financial_settled_at: financialSettledAt,
      is_terminal_fee_outcome: false,
    };
  }

  if (captured != null && captured > 0) {
    const credit = resolveCapturedTripEarningNetPence({
      trip: trip as TripSettlementTripRow,
      captureAmountPence: captured,
      tipPence: tipsPence(trip),
    });
    if (credit.settlement != null) {
      return {
        expected_entitlement_pence: credit.driverNetPence + otherDriverEntitlementPence(trip),
        expected_stamp_status: FR_EXPECTED_STAMP_STATUS.OK,
        entitlement_source: "trip_settlement_from_capture",
        financial_settled_at: financialSettledAt,
        is_terminal_fee_outcome: false,
      };
    }
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
    is_terminal_fee_outcome: isTerminal,
  };
}

export type FrDriverSettlementTripForReconciliation = {
  trip_id: string | null;
  driver_net_pence: number | null;
  expected_entitlement_pence?: number | null;
  expected_stamp_status?: FrExpectedStampStatus;
  financial_settled_at?: string | null;
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
export function buildFrDriverSettlementTripRow(args: {
  trip: Record<string, unknown>;
  session?: Record<string, unknown> | null;
  settlement?: Record<string, unknown> | null;
}): FrDriverSettlementTripForReconciliation {
  const trip = args.trip;
  const session = args.session ?? null;
  const settlement = args.settlement ?? null;
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
    gross_fare_pence: trip.gross_fare_pence == null ? null : Number(trip.gross_fare_pence),
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
    captured_at: (session?.captured_at as string | null) ?? null,
    completed_at: (trip.completed_at as string | null) ?? null,
    settlement_settled_at: (settlement?.settled_at as string | null) ?? null,
    settlement_capture_time: (settlement?.capture_time as string | null) ?? null,
  });
  return {
    trip_id: trip.id == null ? null : String(trip.id),
    driver_net_pence: trip.driver_net_pence == null ? null : Number(trip.driver_net_pence),
    expected_entitlement_pence: resolution.expected_entitlement_pence,
    expected_stamp_status: resolution.expected_stamp_status,
    financial_settled_at: resolution.financial_settled_at,
    settlement_status: (settlement?.settlement_status as string | null) ?? null,
    completed_at: (trip.completed_at as string | null) ?? null,
    trip_code: (trip.trip_code as string | null) ?? null,
  };
}
