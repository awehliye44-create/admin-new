/**
 * Post-capture canonical settlement — credit wallet/ledger once per trip capture.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import { creditCapturedCardTripLedger } from "./onecabFinanceLedger.ts";
import {
  resolveCapturedTripEarningNetPence,
  type TripSettlementTripRow,
} from "./tripSettlement.ts";

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

  const credit = resolveCapturedTripEarningNetPence({
    trip: args.trip as TripSettlementTripRow,
    captureAmountPence: args.captureAmountPence,
    tipPence: args.tipPence,
  });

  try {
    await creditCapturedCardTripLedger(args.supabase, {
      driverId,
      tripId,
      driverNetPence: credit.driverNetPence,
      tipPence: credit.tipPence,
      currency: String(args.trip.currency_code ?? args.trip.currency ?? "GBP"),
      paymentId: args.trip.provider_order_id
        ? String(args.trip.provider_order_id)
        : null,
      commissionPct: credit.commissionPct,
    });
  } catch (err) {
    console.error("[applyCanonicalSettlementAfterCapture] ledger credit failed", {
      trip_id: tripId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
