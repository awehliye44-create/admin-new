import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  aggregateLedgerRowsPure,
  filterLedgerRowsByScope,
  resolveAggregationScope,
  type AggregationOutcome,
} from "./driverInvoiceAggregationScope.ts";

export interface DriverInvoiceAggregation {
  cardTripEarningsPence: number;
  cashTripEarningsPence: number;
  airportFeeEarningsPence: number;
  extraChargeEarningsPence: number;
  bonusesPence: number;
  adjustmentsPence: number;
  platformCommissionPence: number;
  cashCollectedOffsetPence: number;
  cardTrips: number;
  cashTrips: number;
  totalTrips: number;
  grossEarningsPence: number;
  netDriverEarningsPence: number;
  completedTripIds: Set<string>;
  outcome: AggregationOutcome;
  includedLedgerIds: string[];
  excludedLedgerIds: string[];
}

export async function aggregateDriverInvoice(
  supabase: SupabaseClient,
  params: {
    driverId: string;
    periodStart: string;
    periodEnd: string;
    currencyCode: string;
    serviceAreaId?: string | null;
  },
): Promise<DriverInvoiceAggregation> {
  const periodEndTs = `${params.periodEnd}T23:59:59.999Z`;
  const scope = resolveAggregationScope(params.serviceAreaId);

  let ledgerQuery = supabase
    .from("driver_wallet_ledger")
    .select("id, type, amount_pence, related_trip_id, service_area_id")
    .eq("driver_id", params.driverId)
    .ilike("currency", params.currencyCode)
    .gte("created_at", params.periodStart)
    .lte("created_at", periodEndTs);

  // Exact SA filter only when scoped. Global scope must NOT add service_area_id IS NULL.
  if (scope === "service_area" && params.serviceAreaId) {
    ledgerQuery = ledgerQuery.eq("service_area_id", params.serviceAreaId);
  }

  const { data: ledgerData, error: ledgerError } = await ledgerQuery;
  if (ledgerError) {
    const failed = aggregateLedgerRowsPure([], {
      serviceAreaId: params.serviceAreaId,
      queryFailed: true,
    });
    return emptyAgg(failed);
  }

  const rawRows = (ledgerData ?? []).map((r) => ({
    id: r.id as string,
    type: String(r.type ?? ""),
    amount_pence: Number(r.amount_pence ?? 0),
    related_trip_id: (r.related_trip_id as string | null) ?? null,
    service_area_id: (r.service_area_id as string | null) ?? null,
    driver_id: params.driverId,
  }));

  const { scoped, excludedByScope } = filterLedgerRowsByScope(rawRows, params.serviceAreaId);
  const outcome = aggregateLedgerRowsPure(scoped, { serviceAreaId: params.serviceAreaId });

  let tripsQuery = supabase
    .from("trips")
    .select("id, payment_method, airport_charge_pence, extras_pence, customer_modification_charge_pence")
    .eq("driver_id", params.driverId)
    .eq("status", "completed")
    .gte("completed_at", params.periodStart)
    .lte("completed_at", periodEndTs);

  if (scope === "service_area" && params.serviceAreaId) {
    tripsQuery = tripsQuery.eq("service_area_id", params.serviceAreaId);
  }

  const { data: tripsData, error: tripsError } = await tripsQuery;
  if (tripsError) throw new Error(tripsError.message);

  const cardTripIds = new Set<string>();
  const cashTripIds = new Set<string>();
  let airportFeeEarningsPence = 0;
  let extraChargeEarningsPence = 0;

  for (const trip of tripsData ?? []) {
    const pm = (trip.payment_method ?? "").toLowerCase();
    if (pm === "cash") cashTripIds.add(trip.id);
    else cardTripIds.add(trip.id);
    airportFeeEarningsPence += Math.max(0, Number(trip.airport_charge_pence ?? 0));
    extraChargeEarningsPence += Math.max(0, Number(trip.extras_pence ?? 0))
      + Math.max(0, Number(trip.customer_modification_charge_pence ?? 0));
  }

  let cardTripEarningsPence = 0;
  let cashTripEarningsPence = 0;
  let bonusesPence = 0;
  let adjustmentsPence = 0;
  let platformCommissionPence = 0;
  const cashCollectedOffsetPence = 0;
  const completedTripIds = new Set<string>();
  const includedLedgerIds: string[] = [];
  const excludedLedgerIds: string[] = excludedByScope.map((r) => r.id ?? `${r.type}`);

  for (const entry of scoped) {
    const amt = Number(entry.amount_pence ?? 0);
    const tripId = entry.related_trip_id as string | null;
    const id = entry.id ?? `${entry.type}:${amt}`;
    switch (entry.type) {
      case "TRIP_EARNING_NET":
        cardTripEarningsPence += amt;
        includedLedgerIds.push(id);
        if (tripId) completedTripIds.add(tripId);
        break;
      case "CASH_TRIP_EARNING":
        cashTripEarningsPence += amt;
        includedLedgerIds.push(id);
        if (tripId) completedTripIds.add(tripId);
        break;
      case "TIP_CREDIT":
      case "DRIVER_TIP_CREDIT":
        cardTripEarningsPence += amt;
        includedLedgerIds.push(id);
        break;
      case "PLATFORM_COMMISSION":
      case "COMPANY_COMMISSION":
        platformCommissionPence += Math.abs(amt);
        includedLedgerIds.push(id);
        break;
      case "BONUS":
      case "INCENTIVE":
        bonusesPence += amt;
        includedLedgerIds.push(id);
        break;
      case "ADJUSTMENT":
      case "REFUND_DEBIT":
      case "LEDGER_REVERSAL":
        adjustmentsPence += amt;
        includedLedgerIds.push(id);
        break;
      case "PENALTY":
      case "DEDUCTION":
        adjustmentsPence -= Math.abs(amt);
        includedLedgerIds.push(id);
        break;
      default:
        excludedLedgerIds.push(id);
        break;
    }
  }

  const cardTrips = cardTripIds.size;
  const cashTrips = cashTripIds.size;
  const totalTrips = new Set([...cardTripIds, ...cashTripIds, ...completedTripIds]).size;

  const grossEarningsPence = cardTripEarningsPence + cashTripEarningsPence
    + airportFeeEarningsPence + extraChargeEarningsPence + bonusesPence
    + Math.max(0, adjustmentsPence);

  const netDriverEarningsPence = cardTripEarningsPence + cashTripEarningsPence
    + airportFeeEarningsPence + extraChargeEarningsPence + bonusesPence + adjustmentsPence
    - platformCommissionPence;

  const outcomeWithDisplay: AggregationOutcome = {
    ...outcome,
    netDriverEarningsPence,
    grossEarningsPence,
    platformCommissionPence,
    includedRowCount: includedLedgerIds.length,
  };

  return {
    cardTripEarningsPence,
    cashTripEarningsPence,
    airportFeeEarningsPence,
    extraChargeEarningsPence,
    bonusesPence,
    adjustmentsPence,
    platformCommissionPence,
    cashCollectedOffsetPence,
    cardTrips,
    cashTrips,
    totalTrips,
    grossEarningsPence,
    netDriverEarningsPence,
    completedTripIds,
    outcome: outcomeWithDisplay,
    includedLedgerIds,
    excludedLedgerIds,
  };
}

function emptyAgg(outcome: AggregationOutcome): DriverInvoiceAggregation {
  return {
    cardTripEarningsPence: 0,
    cashTripEarningsPence: 0,
    airportFeeEarningsPence: 0,
    extraChargeEarningsPence: 0,
    bonusesPence: 0,
    adjustmentsPence: 0,
    platformCommissionPence: 0,
    cashCollectedOffsetPence: 0,
    cardTrips: 0,
    cashTrips: 0,
    totalTrips: 0,
    grossEarningsPence: 0,
    netDriverEarningsPence: 0,
    completedTripIds: new Set(),
    outcome,
    includedLedgerIds: [],
    excludedLedgerIds: [],
  };
}

export function buildInvoiceItems(
  invoiceId: string,
  agg: DriverInvoiceAggregation,
): Array<Record<string, unknown>> {
  const items: Array<Record<string, unknown>> = [];
  let sort = 1;

  const push = (type: string, description: string, trips: number, amount: number) => {
    if (amount === 0 && trips === 0) return;
    items.push({
      invoice_id: invoiceId,
      item_type: type,
      description,
      quantity: trips,
      unit_price_pence: trips > 0 ? Math.round(amount / trips) : amount,
      amount_pence: amount,
      sort_order: sort++,
    });
  };

  push("trip_earnings", "Completed Card Trip Earnings", agg.cardTrips, agg.cardTripEarningsPence);
  push("other", "Airport Fee Earnings", 0, agg.airportFeeEarningsPence);
  push("other", "Extra Charge Earnings", 0, agg.extraChargeEarningsPence);
  if (agg.bonusesPence > 0) push("bonus", "Bonuses", 0, agg.bonusesPence);
  if (agg.adjustmentsPence !== 0) push("adjustment", "Adjustments", 0, agg.adjustmentsPence);
  if (agg.platformCommissionPence > 0) {
    items.push({
      invoice_id: invoiceId,
      item_type: "commission",
      description: "Platform Commission",
      quantity: 1,
      unit_price_pence: -agg.platformCommissionPence,
      amount_pence: -agg.platformCommissionPence,
      sort_order: sort++,
    });
  }

  return items;
}
