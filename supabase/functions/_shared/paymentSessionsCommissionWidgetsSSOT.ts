/**
 * Payment Sessions (SSOT) — ONECAB commission + driver net overview widgets.
 * Consumes trip settlement commission / driver_net + Payment Sessions provider fees.
 * Never invents commission from fares when trip settlement is missing.
 */

import {
  buildCommissionFeeBreakdownRow,
  summarizeCommissionFeeRows,
  type CommissionFeeSessionInput,
  type CommissionFeeTripInput,
} from "./driverWalletCommissionFeeSSOT.ts";

export type PaymentSessionsCommissionWidgetTrip = CommissionFeeTripInput & {
  driver_net_pence?: number | null;
};

export type PaymentSessionsCommissionWidgets = {
  /** SUM trip gross ONECAB commission (settlement snapshot). */
  gross_onecab_commission_pence: number | null;
  /** Gross − provider fees (fees never count as ONECAB revenue). */
  net_onecab_commission_pence: number | null;
  /** SUM trip driver_net_pence (driver-owned settlement). */
  driver_net_total_pence: number | null;
  transaction_count: number;
};

/**
 * Build PS overview commission widgets from completed-trip settlement rows.
 * Provider fee comes from the linked Payment Session when present.
 */
export function buildPaymentSessionsCommissionWidgets(args: {
  trips: PaymentSessionsCommissionWidgetTrip[];
  sessionByTripId?: Map<string, CommissionFeeSessionInput | null | undefined> | null;
}): PaymentSessionsCommissionWidgets {
  const trips = args.trips ?? [];
  if (trips.length === 0) {
    return {
      gross_onecab_commission_pence: null,
      net_onecab_commission_pence: null,
      driver_net_total_pence: null,
      transaction_count: 0,
    };
  }

  const rows = trips.map((trip) => {
    const session = args.sessionByTripId?.get(trip.trip_id) ?? null;
    return buildCommissionFeeBreakdownRow({ trip, session });
  });
  const commission = summarizeCommissionFeeRows(rows);

  let driverNet: number | null = null;
  for (const trip of trips) {
    if (trip.driver_net_pence == null) continue;
    const n = Number(trip.driver_net_pence);
    if (!Number.isFinite(n)) continue;
    driverNet = (driverNet ?? 0) + Math.max(0, Math.round(n));
  }

  return {
    gross_onecab_commission_pence: commission.gross_onecab_commission_pence,
    net_onecab_commission_pence: commission.net_onecab_commission_pence,
    driver_net_total_pence: driverNet,
    transaction_count: commission.transaction_count,
  };
}

/** Resolve gross commission pence from trip settlement columns (never invent). */
export function resolveTripGrossCommissionPence(trip: {
  commission_pence?: unknown;
  platform_commission_amount?: unknown;
  gross_commission_pence?: unknown;
}): number | null {
  const candidates = [
    trip.gross_commission_pence,
    trip.commission_pence,
    trip.platform_commission_amount,
  ];
  for (const c of candidates) {
    if (c == null) continue;
    const n = Number(c);
    if (!Number.isFinite(n) || n < 0) continue;
    return Math.round(n);
  }
  return null;
}
