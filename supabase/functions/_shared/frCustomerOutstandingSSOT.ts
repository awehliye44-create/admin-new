/**
 * FR — Customer outstanding classification SSOT (read-only).
 *
 * Declined-waiting shortfalls are CUSTOMER_OUTSTANDING — separate from
 * wallet / payout variance. Overview sums open receivables (e.g. 36p, 2 trips).
 *
 * Policy A: TEN unchanged; no wallet repair; no second commission/payout.
 */

import {
  POLICY_A,
  TEN_REPAIR_FORBIDDEN,
  sumFixtureOutstandingPence,
  sumOpenReceivablePence,
  type OpenReceivableRow,
} from "./customerReceivableSSOT.ts";

export const FR_CUSTOMER_OUTSTANDING_CLASS = {
  CUSTOMER_OUTSTANDING: "CUSTOMER_OUTSTANDING",
  FULLY_SETTLED: "FULLY_SETTLED",
  PROVIDER_CAPTURE_UNKNOWN: "PROVIDER_CAPTURE_UNKNOWN",
} as const;

export type FrCustomerOutstandingClass =
  (typeof FR_CUSTOMER_OUTSTANDING_CLASS)[keyof typeof FR_CUSTOMER_OUTSTANDING_CLASS];

export type FrCustomerOutstandingTripInput = {
  trip_code?: string | null;
  trip_id?: string | null;
  final_fare_pence?: number | null;
  capture_amount_pence?: number | null;
  outstanding_balance_pence?: number | null;
  provider_state?: string | null;
  pickup_waiting_charge_pence?: number | null;
  /** Open receivable outstanding for this trip when ledger present. */
  receivable_outstanding_pence?: number | null;
};

export type FrCustomerOutstandingTripRow = {
  trip_code: string | null;
  trip_id: string | null;
  total_due_pence: number;
  captured_pence: number;
  outstanding_pence: number;
  fr_class: FrCustomerOutstandingClass;
};

export type FrCustomerOutstandingOverview = {
  customer_outstanding_pence: number;
  affected_trips: number;
  trips: FrCustomerOutstandingTripRow[];
  /** Never merge into wallet/payout variance buckets. */
  separate_from_wallet_payout_variance: true;
  ten_repair_forbidden: typeof TEN_REPAIR_FORBIDDEN;
  policy: typeof POLICY_A.DRIVER_ENTITLEMENT;
};

function nonNeg(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n);
}

export function classifyTripCustomerOutstanding(
  input: FrCustomerOutstandingTripInput,
): FrCustomerOutstandingTripRow {
  const total_due_pence = nonNeg(input.final_fare_pence);
  const captured_pence = nonNeg(input.capture_amount_pence);
  const computed = Math.max(0, total_due_pence - captured_pence);
  const stored = nonNeg(input.outstanding_balance_pence);
  const fromReceivable = nonNeg(input.receivable_outstanding_pence);

  let outstanding_pence = fromReceivable > 0
    ? fromReceivable
    : stored > 0 && Math.abs(stored - computed) <= 1
    ? stored
    : captured_pence > 0
    ? computed
    : stored > 0
    ? stored
    : 0;

  const providerUnknown = String(input.provider_state ?? "")
    .trim()
    .toUpperCase() === "UNKNOWN";

  const fr_class = providerUnknown
    ? FR_CUSTOMER_OUTSTANDING_CLASS.PROVIDER_CAPTURE_UNKNOWN
    : outstanding_pence > 0
    ? FR_CUSTOMER_OUTSTANDING_CLASS.CUSTOMER_OUTSTANDING
    : FR_CUSTOMER_OUTSTANDING_CLASS.FULLY_SETTLED;

  if (providerUnknown) {
    outstanding_pence = fromReceivable > 0 ? fromReceivable : outstanding_pence;
  }

  return {
    trip_code: input.trip_code ? String(input.trip_code) : null,
    trip_id: input.trip_id ? String(input.trip_id) : null,
    total_due_pence,
    captured_pence,
    outstanding_pence,
    fr_class,
  };
}

/**
 * FR overview: sum open receivables; list affected trips.
 * Example: 36p across MK-012 (30) + MK-017 (6).
 */
export function buildFrCustomerOutstandingOverview(args: {
  trips: FrCustomerOutstandingTripInput[];
  open_receivables?: OpenReceivableRow[];
}): FrCustomerOutstandingOverview {
  const trips = (args.trips ?? []).map(classifyTripCustomerOutstanding);
  const outstandingTrips = trips.filter(
    (t) =>
      t.fr_class === FR_CUSTOMER_OUTSTANDING_CLASS.CUSTOMER_OUTSTANDING
      && t.outstanding_pence > 0,
  );

  const fromReceivables = args.open_receivables
    ? sumOpenReceivablePence(args.open_receivables)
    : 0;
  const fromTrips = outstandingTrips.reduce((s, t) => s + t.outstanding_pence, 0);

  return {
    customer_outstanding_pence: fromReceivables > 0 ? fromReceivables : fromTrips,
    affected_trips: outstandingTrips.length,
    trips: outstandingTrips,
    separate_from_wallet_payout_variance: true,
    ten_repair_forbidden: TEN_REPAIR_FORBIDDEN,
    policy: POLICY_A.DRIVER_ENTITLEMENT,
  };
}

/** Fixture: MK-012 30p + MK-017 6p = 36p same customer. */
export function mk012Mk017BackfillPreviewPence(): {
  mk012_pence: 30;
  mk017_pence: 6;
  total_pence: 36;
} {
  const total = sumFixtureOutstandingPence({
    mk012_outstanding_pence: 30,
    mk017_outstanding_pence: 6,
  });
  return { mk012_pence: 30, mk017_pence: 6, total_pence: total as 36 };
}
