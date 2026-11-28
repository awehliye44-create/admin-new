/**
 * #93C / #94A — Post-capture ledger integrity recovery (GET/session evidence only).
 *
 * Heals when TEN already exists but:
 * - DRIVER_TIP_CREDIT is missing while tip stamps > 0, or
 * - TRIP_EARNING_PENDING exists without PENDING_RELEASE.
 *
 * Reuses creditCapturedCardTripLedger via applyCanonicalSettlementAfterCapture.
 * Never POSTs to Revolut. Never invents amounts. Never backfills historical PENDING.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import { applyCanonicalSettlementAfterCapture } from "../../_shared/applyCanonicalSettlementAfterCapture.ts";
import {
  expectedTenCreditFromSavedStamps,
  INCOMPLETE_SETTLEMENT_RECOVERY_ACTIVATED_AT_MS,
  isPlatformCollectedModel,
} from "../../_shared/missingTripEarningNetRecoverySSOT.ts";
import {
  loadPaymentSessionCaptureGate,
} from "../../_shared/paymentSessionCaptureGateSSOT.ts";
import { paymentSessionAllowsWalletPosting } from "../../_shared/postCaptureSettlementBoundary.ts";
import { readTripEarningNetLedgerState } from "../../_shared/tripEarningNetLedgerReadback.ts";
import {
  TRIP_EARNING_PENDING_RELEASE_TYPE,
  TRIP_EARNING_PENDING_TYPE,
} from "../../_shared/tripEarningPendingSSOT.ts";

export type PostCaptureLedgerIntegrityResult = {
  trip_id: string;
  trip_code: string | null;
  status:
    | "HEALED"
    | "ALREADY_INTEGRITY"
    | "SKIPPED"
    | "FAILED";
  reason?: string;
  tip_healed?: boolean;
  release_healed?: boolean;
};

export async function recoverPostCaptureLedgerIntegrityBatch(
  supabase: SupabaseClient,
  args?: { limit?: number; dryRun?: boolean },
): Promise<{ scanned: number; results: PostCaptureLedgerIntegrityResult[] }> {
  const limit = Math.min(30, Math.max(1, Number(args?.limit ?? 15)));
  const dryRun = args?.dryRun === true;
  const since = new Date(Date.now() - 14 * 24 * 3600_000).toISOString();

  // TEN rows in lookback — check tip / RELEASE gaps.
  const { data: tenRows } = await supabase
    .from("driver_wallet_ledger")
    .select("related_trip_id, created_at")
    .eq("type", "TRIP_EARNING_NET")
    .not("related_trip_id", "is", null)
    .gte("created_at", since)
    .order("created_at", { ascending: true })
    .limit(limit * 6);

  const tripIds = [
    ...new Set(
      (tenRows ?? [])
        .map((r) => String(r.related_trip_id ?? "").trim())
        .filter(Boolean),
    ),
  ];

  const results: PostCaptureLedgerIntegrityResult[] = [];
  let scanned = 0;

  for (const tripId of tripIds) {
    if (results.length >= limit) break;

    const { data: trip } = await supabase
      .from("trips")
      .select(
        "id, trip_code, driver_id, driver_net_pence, airport_charge_pence, financial_model, "
          + "status, tip_pence, tip_amount_pence, currency_code, currency, "
          + "accepted_commission_percent, driver_tier_commission_percent, commission_pct, created_at",
      )
      .eq("id", tripId)
      .maybeSingle();

    if (!trip || String(trip.status) !== "completed") continue;
    if (!isPlatformCollectedModel(trip.financial_model)) continue;
    const driverId = String(trip.driver_id ?? "").trim();
    if (!driverId) continue;

    const expected = expectedTenCreditFromSavedStamps(trip);
    if (expected <= 0) continue;

    const ten = await readTripEarningNetLedgerState(supabase, tripId);
    if (ten.count !== 1 || ten.totalPence !== expected) continue;

    const tipOwed = Math.max(
      0,
      Math.round(Number(trip.tip_pence ?? trip.tip_amount_pence) || 0),
    );

    const { data: tipRow } = tipOwed > 0
      ? await supabase
        .from("driver_wallet_ledger")
        .select("id")
        .eq("related_trip_id", tripId)
        .eq("type", "DRIVER_TIP_CREDIT")
        .maybeSingle()
      : { data: { id: "skip" } };

    const { data: pending } = await supabase
      .from("driver_wallet_ledger")
      .select("id")
      .eq("related_trip_id", tripId)
      .eq("type", TRIP_EARNING_PENDING_TYPE)
      .maybeSingle();

    let needsRelease = false;
    if (pending) {
      const { data: release } = await supabase
        .from("driver_wallet_ledger")
        .select("id")
        .eq("related_trip_id", tripId)
        .eq("type", TRIP_EARNING_PENDING_RELEASE_TYPE)
        .maybeSingle();
      needsRelease = !release;
    }

    const needsTip = tipOwed > 0 && !tipRow;
    if (!needsTip && !needsRelease) continue;

    scanned += 1;
    const tripCode = trip.trip_code ? String(trip.trip_code) : null;

    const gate = await loadPaymentSessionCaptureGate(supabase, tripId);
    if (gate.error || !paymentSessionAllowsWalletPosting(gate.session)) {
      results.push({
        trip_id: tripId,
        trip_code: tripCode,
        status: "SKIPPED",
        reason: gate.error?.message ?? "payment_session_capture_unverified",
      });
      continue;
    }

    if (dryRun) {
      results.push({
        trip_id: tripId,
        trip_code: tripCode,
        status: "HEALED",
        reason: "dry_run",
        tip_healed: needsTip,
        release_healed: needsRelease,
      });
      continue;
    }

    try {
      await applyCanonicalSettlementAfterCapture({
        supabase,
        tripId,
        trip,
        captureAmountPence: Math.round(
          Number(gate.session?.captured_amount_pence) || 0,
        ),
        tipPence: tipOwed,
        mode: "recovery",
        activatedAtMs: INCOMPLETE_SETTLEMENT_RECOVERY_ACTIVATED_AT_MS,
      });
      results.push({
        trip_id: tripId,
        trip_code: tripCode,
        status: "HEALED",
        tip_healed: needsTip,
        release_healed: needsRelease,
      });
    } catch (e) {
      results.push({
        trip_id: tripId,
        trip_code: tripCode,
        status: "FAILED",
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return { scanned, results };
}
