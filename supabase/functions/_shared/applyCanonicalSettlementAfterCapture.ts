/**
 * Post-capture canonical settlement — credit wallet/ledger once per trip capture.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import { creditCapturedCardTripLedger } from "./onecabFinanceLedger.ts";
import { calculateTripSettlement, resolveTripTierPercent } from "./tripSettlement.ts";

export async function applyCanonicalSettlementAfterCapture(args: {
  supabase: SupabaseClient;
  tripId: string;
  trip: Record<string, unknown>;
  captureAmountPence: number;
  tipPence?: number;
}): Promise<void> {
  const tripId = String(args.tripId);
  const driverId = args.trip.driver_id ? String(args.trip.driver_id) : "";
  if (!tripId || !driverId) {
    console.log("[applyCanonicalSettlementAfterCapture] skip — missing trip or driver", {
      trip_id: tripId || null,
    });
    return;
  }

  const tip = Math.max(0, Math.round(Number(args.tipPence ?? args.trip.tip_pence ?? args.trip.tip_amount_pence ?? 0)));
  let driverNet = Math.max(0, Math.round(Number(args.trip.driver_net_pence ?? 0)));
  let commissionPct: number | undefined =
    args.trip.accepted_commission_percent != null
      ? Number(args.trip.accepted_commission_percent)
      : args.trip.driver_tier_commission_percent != null
      ? Number(args.trip.driver_tier_commission_percent)
      : args.trip.commission_pct != null
      ? Number(args.trip.commission_pct)
      : undefined;

  // When stop-workflow invokes finalize before persisting settlement columns,
  // derive net via existing tripSettlement SSOT (never invent outside that formula).
  if (driverNet <= 0) {
    const finalFare = Math.max(
      0,
      Math.round(
        Number(
          args.trip.final_fare_pence
            ?? args.captureAmountPence
            ?? args.trip.capture_amount_pence
            ?? 0,
        ),
      ),
    );
    const tier = Number(
      commissionPct
        ?? resolveTripTierPercent(args.trip as Parameters<typeof resolveTripTierPercent>[0])
        ?? 0,
    );
    if (finalFare > 0 && tier > 0) {
      const settlement = calculateTripSettlement({
        final_fare_pence: finalFare,
        airport_charge_pence: Number(args.trip.airport_charge_pence ?? 0),
        tips_pence: tip,
        driver_tier_commission_percent: tier,
        provider_fee_pence: Number(args.trip.provider_fee_pence ?? 0),
      });
      driverNet = settlement.driver_net_pence;
      commissionPct = settlement.tier_percent_used;
    }
  }

  try {
    await creditCapturedCardTripLedger(args.supabase, {
      driverId,
      tripId,
      driverNetPence: driverNet,
      tipPence: tip,
      currency: String(args.trip.currency_code ?? args.trip.currency ?? "GBP"),
      paymentId: args.trip.provider_order_id
        ? String(args.trip.provider_order_id)
        : null,
      commissionPct,
    });
  } catch (err) {
    console.error("[applyCanonicalSettlementAfterCapture] ledger credit failed", {
      trip_id: tripId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
