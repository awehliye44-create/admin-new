/**
 * #98 / #93E — Recover missing TRIP_EARNING_PENDING after completed PC card trips.
 * Never invents amount (saved stamps only). Never posts TEN. Never voids entitlement.
 *
 * Eligibility is independent of tip-window length: any completed PC trip still
 * awaiting capture, with no TEN and no PENDING, is recovered immediately.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  creditTripEarningPending,
  pendingEntitlementAmountPence,
  TRIP_EARNING_PENDING_TYPE,
} from "./tripEarningPendingSSOT.ts";
import { isPlatformCollectedModel } from "./missingTripEarningNetRecoverySSOT.ts";
import { readTripEarningNetLedgerState } from "./tripEarningNetLedgerReadback.ts";
import { recordPaymentFinancialEvent } from "./paymentFinancialDiagnosticsSSOT.ts";

export type MissingPendingRecoveryResult = {
  trip_id: string;
  trip_code: string | null;
  status: "INSERTED" | "ALREADY_PRESENT" | "TEN_EXISTS" | "SKIPPED" | "FAILED";
  amount_pence?: number;
  reason?: string;
  completed_age_seconds?: number;
};

/** Payment statuses that mean capture has not confirmed yet (tip window included). */
export const PENDING_RECOVERY_AWAITING_CAPTURE_STATUSES = [
  "capture_requested",
  "authorized",
  "authorised",
  "authorizing",
  "authorising",
  "pending",
  "tip_window_open",
  "awaiting_tip",
  "preauth_authorized",
  "preauth_authorised",
  "preauth_created",
  "preauth_updated",
] as const;

const TERMINAL_CAPTURED = new Set(["captured", "paid", "succeeded"]);

export async function recoverMissingTripEarningPendingBatch(
  supabase: SupabaseClient,
  args?: { limit?: number },
): Promise<{ scanned: number; results: MissingPendingRecoveryResult[] }> {
  const limit = Math.min(30, Math.max(1, Number(args?.limit ?? 15)));
  const since = new Date(Date.now() - 48 * 3600_000).toISOString();
  const nowMs = Date.now();

  // Filter awaiting-capture in SQL so captured history cannot crowd out open tip windows.
  const awaitingList = PENDING_RECOVERY_AWAITING_CAPTURE_STATUSES.join(",");
  const { data: trips, error: tripsErr } = await supabase
    .from("trips")
    .select(
      "id, trip_code, driver_id, driver_net_pence, airport_charge_pence, financial_model, "
        + "status, payment_status, completed_at",
    )
    .eq("status", "completed")
    .eq("financial_model", "PLATFORM_COLLECTED")
    .gte("completed_at", since)
    .gt("driver_net_pence", 0)
    .or(`payment_status.in.(${awaitingList}),payment_status.is.null`)
    .order("completed_at", { ascending: false })
    .limit(limit * 3);

  if (tripsErr) {
    console.error("[missingTripEarningPendingRecovery] trip select failed", tripsErr);
    await recordPaymentFinancialEvent(supabase, {
      eventType: "missing_pending_recovery_select_failed",
      detail: {
        message: tripsErr.message,
        recovery_failed: true,
      },
    });
    return { scanned: 0, results: [] };
  }

  const results: MissingPendingRecoveryResult[] = [];
  let scanned = 0;
  let actionable = 0;

  for (const trip of trips ?? []) {
    if (actionable >= limit) break;
    if (!isPlatformCollectedModel(trip.financial_model)) continue;
    const tripId = String(trip.id);
    const driverId = String(trip.driver_id ?? "").trim();
    if (!driverId) continue;

    const pay = String(trip.payment_status ?? "").toLowerCase();
    if (TERMINAL_CAPTURED.has(pay)) continue;
    const awaiting = pay === ""
      || (PENDING_RECOVERY_AWAITING_CAPTURE_STATUSES as readonly string[]).includes(pay);
    if (!awaiting) continue;

    const completedAgeSeconds = trip.completed_at
      ? Math.max(0, Math.floor((nowMs - new Date(String(trip.completed_at)).getTime()) / 1000))
      : undefined;

    scanned += 1;
    const ten = await readTripEarningNetLedgerState(supabase, tripId);
    if (ten.count > 0) {
      results.push({
        trip_id: tripId,
        trip_code: trip.trip_code ?? null,
        status: "TEN_EXISTS",
        completed_age_seconds: completedAgeSeconds,
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
        completed_age_seconds: completedAgeSeconds,
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
        completed_age_seconds: completedAgeSeconds,
      });
      continue;
    }

    actionable += 1;
    try {
      const r = await creditTripEarningPending(supabase, {
        tripId,
        driverId,
        amountPence: amount,
      });
      const status: MissingPendingRecoveryResult["status"] = r.inserted
        ? "INSERTED"
        : (r.ok ? "ALREADY_PRESENT" : "FAILED");
      const row: MissingPendingRecoveryResult = {
        trip_id: tripId,
        trip_code: trip.trip_code ?? null,
        status,
        amount_pence: amount,
        reason: r.reason,
        completed_age_seconds: completedAgeSeconds,
      };
      results.push(row);

      if (status === "FAILED") {
        console.error("[missingTripEarningPendingRecovery] insert failed", row);
        await recordPaymentFinancialEvent(supabase, {
          tripId,
          eventType: "missing_pending_recovery_failed",
          declineCode: r.reason,
          requestedAmountPence: amount,
          detail: {
            trip_code: trip.trip_code ?? null,
            reason: r.reason,
            message: r.message ?? null,
            completed_age_seconds: completedAgeSeconds ?? null,
            recovery_failed: true,
          },
        });
      } else if (status === "INSERTED") {
        console.log("[missingTripEarningPendingRecovery] inserted", row);
      }
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      const row: MissingPendingRecoveryResult = {
        trip_id: tripId,
        trip_code: trip.trip_code ?? null,
        status: "FAILED",
        reason,
        completed_age_seconds: completedAgeSeconds,
      };
      results.push(row);
      console.error("[missingTripEarningPendingRecovery] exception", row);
      await recordPaymentFinancialEvent(supabase, {
        tripId,
        eventType: "missing_pending_recovery_failed",
        declineCode: "exception",
        requestedAmountPence: amount,
        detail: {
          trip_code: trip.trip_code ?? null,
          reason,
          completed_age_seconds: completedAgeSeconds ?? null,
          recovery_failed: true,
        },
      });
    }
  }

  const failed = results.filter((r) => r.status === "FAILED");
  if (failed.length > 0) {
    console.error("[missingTripEarningPendingRecovery] batch failures", {
      scanned,
      actionable,
      failed_count: failed.length,
      failed,
    });
  } else {
    console.log("[missingTripEarningPendingRecovery] batch complete", {
      scanned,
      actionable,
      inserted: results.filter((r) => r.status === "INSERTED").length,
    });
  }

  return { scanned, results };
}
