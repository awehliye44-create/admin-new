/**
 * Post-capture canonical settlement — credit wallet/ledger once per trip capture.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import { creditCapturedCardTripLedger } from "./onecabFinanceLedger.ts";

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

  const driverNet = Math.max(0, Math.round(Number(args.trip.driver_net_pence ?? 0)));
  const tip = Math.max(0, Math.round(Number(args.tipPence ?? args.trip.tip_pence ?? 0)));

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
    });
  } catch (err) {
    console.error("[applyCanonicalSettlementAfterCapture] ledger credit failed", {
      trip_id: tripId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
