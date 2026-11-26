/**
 * #98 — Recover missing TRIP_EARNING_PENDING after completed PC card trips.
 * Never invents amount (saved stamps only). Never posts TEN. Never voids entitlement.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  creditTripEarningPending,
  pendingEntitlementAmountPence,
  TRIP_EARNING_PENDING_TYPE,
} from "./tripEarningPendingSSOT.ts";
import { isPlatformCollectedModel } from "./missingTripEarningNetRecoverySSOT.ts";
import { readTripEarningNetLedgerState } from "./tripEarningNetLedgerReadback.ts";

export type MissingPendingRecoveryResult = {
  trip_id: string;
  trip_code: string | null;
  status: "INSERTED" | "ALREADY_PRESENT" | "TEN_EXISTS" | "SKIPPED" | "FAILED";
  amount_pence?: number;
  reason?: string;
};

export async function recoverMissingTripEarningPendingBatch(
  supabase: SupabaseClient,
  args?: { limit?: number },
): Promise<{ scanned: number; results: MissingPendingRecoveryResult[] }> {
  const limit = Math.min(30, Math.max(1, Number(args?.limit ?? 15)));
  const since = new Date(Date.now() - 48 * 3600_000).toISOString();

  const { data: trips } = await supabase
    .from("trips")
    .select(
      "id, trip_code, driver_id, driver_net_pence, airport_charge_pence, financial_model, "
        + "status, payment_status, completed_at",
    )
    .eq("status", "completed")
    .eq("financial_model", "PLATFORM_COLLECTED")
    .gte("completed_at", since)
    .gt("driver_net_pence", 0)
    .order("completed_at", { ascending: false })
    .limit(limit * 3);

  const results: MissingPendingRecoveryResult[] = [];
  let scanned = 0;

  for (const trip of trips ?? []) {
    if (results.length >= limit) break;
    if (!isPlatformCollectedModel(trip.financial_model)) continue;
    const tripId = String(trip.id);
    const driverId = String(trip.driver_id ?? "").trim();
    if (!driverId) continue;

    // #94A: only while still awaiting capture. Never invent PENDING after
    // terminal payment failure / release / shortfall (no historical void path).
    const pay = String(trip.payment_status ?? "").toLowerCase();
    if (pay === "captured" || pay === "paid" || pay === "succeeded") continue;
    const awaitingCapture = new Set([
      "capture_requested",
      "authorized",
      "authorised",
      "authorizing",
      "authorising",
      "pending",
      "tip_window_open",
      "awaiting_tip",
      "",
    ]);
    if (!awaitingCapture.has(pay)) {
      results.push({
        trip_id: tripId,
        trip_code: trip.trip_code ?? null,
        status: "SKIPPED",
        reason: `payment_status_not_awaiting_capture:${pay || "null"}`,
      });
      continue;
    }

    scanned += 1;
    const ten = await readTripEarningNetLedgerState(supabase, tripId);
    if (ten.count > 0) {
      results.push({
        trip_id: tripId,
        trip_code: trip.trip_code ?? null,
        status: "TEN_EXISTS",
      });
      continue;
    }

    const { data: pending } = await supabase
      .from("driver_wallet_ledger")
      .select("id")
      .eq("related_trip_id", tripId)
      .eq("type", TRIP_EARNING_PENDING_TYPE)
      .maybeSingle();
    if (pending) {
      results.push({
        trip_id: tripId,
        trip_code: trip.trip_code ?? null,
        status: "ALREADY_PRESENT",
      });
      continue;
    }

    const amount = pendingEntitlementAmountPence({
      driverNetPence: trip.driver_net_pence,
      airportChargePence: trip.airport_charge_pence,
    });
    if (amount <= 0) {
      results.push({
        trip_id: tripId,
        trip_code: trip.trip_code ?? null,
        status: "SKIPPED",
        reason: "no_entitlement",
      });
      continue;
    }

    try {
      const r = await creditTripEarningPending(supabase, {
        tripId,
        driverId,
        amountPence: amount,
      });
      results.push({
        trip_id: tripId,
        trip_code: trip.trip_code ?? null,
        status: r.inserted ? "INSERTED" : (r.ok ? "ALREADY_PRESENT" : "FAILED"),
        amount_pence: amount,
        reason: r.reason,
      });
    } catch (e) {
      results.push({
        trip_id: tripId,
        trip_code: trip.trip_code ?? null,
        status: "FAILED",
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return { scanned, results };
}
