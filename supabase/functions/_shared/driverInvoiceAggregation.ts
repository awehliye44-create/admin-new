import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

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

  let ledgerQuery = supabase
    .from("driver_wallet_ledger")
    .select("type, amount_pence, related_trip_id, service_area_id")
    .eq("driver_id", params.driverId)
    .eq("currency", params.currencyCode)
    .gte("created_at", params.periodStart)
    .lte("created_at", periodEndTs);

  if (params.serviceAreaId) {
    ledgerQuery = ledgerQuery.eq("service_area_id", params.serviceAreaId);
  }

  const { data: ledgerData, error: ledgerError } = await ledgerQuery;
  if (ledgerError) throw new Error(ledgerError.message);

  let tripsQuery = supabase
    .from("trips")
    .select("id, payment_method, airport_charge_pence, extras_pence, customer_modification_charge_pence")
    .eq("driver_id", params.driverId)
    .eq("status", "completed")
    .gte("completed_at", params.periodStart)
    .lte("completed_at", periodEndTs);

  if (params.serviceAreaId) {
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
  let cashCollectedOffsetPence = 0;
  const completedTripIds = new Set<string>();

  for (const entry of ledgerData ?? []) {
    const amt = Number(entry.amount_pence ?? 0);
    const tripId = entry.related_trip_id as string | null;
    switch (entry.type) {
      case "TRIP_EARNING_NET":
        cardTripEarningsPence += amt;
        if (tripId) completedTripIds.add(tripId);
        break;
      case "CASH_TRIP_EARNING":
        cashTripEarningsPence += amt;
        if (tripId) completedTripIds.add(tripId);
        break;
      case "TIP_CREDIT":
      case "DRIVER_TIP_CREDIT":
        cardTripEarningsPence += amt;
        break;
      case "PLATFORM_COMMISSION":
      case "COMPANY_COMMISSION":
        platformCommissionPence += Math.abs(amt);
        break;
      case "BONUS":
        bonusesPence += amt;
        break;
      case "ADJUSTMENT":
      case "REFUND_DEBIT":
        adjustmentsPence += amt;
        break;
      case "CASH_COMMISSION_DEBT":
        cashCollectedOffsetPence += Math.abs(amt);
        break;
      case "PENALTY":
      case "DEDUCTION":
        adjustmentsPence -= Math.abs(amt);
        break;
      default:
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
    - platformCommissionPence - cashCollectedOffsetPence;

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
  push("trip_earnings", "Completed Cash Trip Earnings", agg.cashTrips, agg.cashTripEarningsPence);
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
  if (agg.cashCollectedOffsetPence > 0) {
    items.push({
      invoice_id: invoiceId,
      item_type: "cash_collected",
      description: "Cash Collected (Offset)",
      quantity: 1,
      unit_price_pence: -agg.cashCollectedOffsetPence,
      amount_pence: -agg.cashCollectedOffsetPence,
      sort_order: sort++,
    });
  }

  return items;
}
