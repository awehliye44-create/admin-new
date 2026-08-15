/**
 * Post-capture canonical settlement — credit wallet/ledger once per trip capture
 * and persist the matching trip settlement stamp (waiting included in commissionable).
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import { creditCapturedCardTripLedger } from "./onecabFinanceLedger.ts";
import {
  resolveCapturedTripEarningNetPence,
  tripSettlementDbColumns,
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

  // Persist stamp from the same settlement that funds TRIP_EARNING_NET so
  // commissionable / commission / driver_net cannot remain ride-only after waiting.
  if (credit.settlement) {
    const { error: stampErr } = await args.supabase.from("trips").update({
      ...tripSettlementDbColumns(credit.settlement),
      capture_amount_pence: Math.max(0, Math.round(Number(args.captureAmountPence) || 0)),
      updated_at: new Date().toISOString(),
    }).eq("id", tripId);
    if (stampErr) {
      console.error("[applyCanonicalSettlementAfterCapture] settlement stamp persist failed", {
        trip_id: tripId,
        error: stampErr.message,
      });
      throw new Error(`settlement stamp persist failed: ${stampErr.message}`);
    }
  }

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
