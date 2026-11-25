/**
 * Automatic recovery for provider-confirmed captures missing TRIP_EARNING_NET.
 *
 * Root cause class (MK-261122-001 / MK-261124-002):
 * post-capture residual release stamped hold_release_state=released before wallet
 * posting; the capture gate then returned PAYMENT_SESSION_CAPTURE_UNVERIFIED and
 * no durable retry posted TEN.
 *
 * Recovery rules:
 * - PLATFORM_COLLECTED only
 * - Payment Sessions verified captured (same gate as fresh posting)
 * - Saved driver_net_pence (+ airport) entitlement only — never recalculate settlement
 * - Exactly-once via creditCapturedCardTripLedger unique / readback
 * - Opt-in past WALLET_POSTING_ACTIVATED_AT detect-only via activatedAtMs: 0
 * - Never mutates existing ledger rows; never calls Revolut
 *
 * Lock: missingTripEarningNetRecoverySSOT.test.ts
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import { applyCanonicalSettlementAfterCapture } from "./applyCanonicalSettlementAfterCapture.ts";
import { SERVICE_AREA_FINANCIAL_MODEL } from "./commissionWalletSSOT.ts";
import { paymentSessionAllowsWalletPosting } from "./postCaptureSettlementBoundary.ts";
import {
  loadPaymentSessionCaptureGate,
  PAYMENT_SESSION_GATE_STATUS,
} from "./paymentSessionCaptureGateSSOT.ts";
import { readTripEarningNetLedgerState } from "./tripEarningNetLedgerReadback.ts";
import type { PostCaptureSettlementResult } from "./postCaptureSettlementResult.ts";

/** Explicit override: incomplete verified-capture settlement may post despite unset activation. */
export const INCOMPLETE_SETTLEMENT_RECOVERY_ACTIVATED_AT_MS = 0;

export const MISSING_TEN_RECOVERY_REASON =
  "PROVIDER_CONFIRMED_CAPTURE_MISSING_TRIP_EARNING_NET" as const;

export type MissingTenRecoveryCandidate = {
  trip_id: string;
  trip_code: string | null;
  driver_id: string;
  driver_net_pence: number;
  airport_charge_pence: number;
  expected_credit_pence: number;
  payment_session_id: string | null;
  captured_amount_pence: number;
};

export type MissingTenRecoveryResult = {
  trip_id: string;
  trip_code: string | null;
  status:
    | "CREDITED"
    | "ALREADY_CREDITED"
    | "SKIPPED_GATE"
    | "SKIPPED_NO_ENTITLEMENT"
    | "SKIPPED_MODEL"
    | "SKIPPED_NO_DRIVER"
    | "FAILED"
    | "DRY_RUN_ELIGIBLE";
  expected_credit_pence?: number;
  posted_pence?: number;
  reason?: string;
  posting?: PostCaptureSettlementResult;
};

export function expectedTenCreditFromSavedStamps(trip: {
  driver_net_pence?: unknown;
  airport_charge_pence?: unknown;
}): number {
  return Math.max(
    0,
    Math.round(Number(trip.driver_net_pence) || 0)
      + Math.round(Number(trip.airport_charge_pence) || 0),
  );
}

export function isPlatformCollectedModel(financialModel: unknown): boolean {
  const model = String(financialModel ?? "").toUpperCase();
  return model === "PLATFORM_COLLECTED"
    || model === SERVICE_AREA_FINANCIAL_MODEL.PLATFORM_COLLECTED;
}

/**
 * Load a bounded cohort of completed PLATFORM_COLLECTED trips that look like
 * verified captures with stamped entitlement and no TRIP_EARNING_NET.
 * Final gate / credit decisions happen per trip in recoverMissingTripEarningNet.
 */
export async function findMissingTripEarningNetCandidates(
  supabase: SupabaseClient,
  args?: { limit?: number },
): Promise<MissingTenRecoveryCandidate[]> {
  const limit = Math.min(50, Math.max(1, Number(args?.limit ?? 20)));
  const { data: trips, error } = await supabase
    .from("trips")
    .select(
      "id, trip_code, driver_id, driver_net_pence, airport_charge_pence, financial_model, payment_session_id, status, payment_status, completed_at",
    )
    .eq("status", "completed")
    .eq("payment_status", "captured")
    .eq("financial_model", "PLATFORM_COLLECTED")
    .gt("driver_net_pence", 0)
    .not("payment_session_id", "is", null)
    .order("completed_at", { ascending: false })
    .limit(Math.max(limit * 5, 50));

  if (error || !Array.isArray(trips) || trips.length === 0) return [];

  const out: MissingTenRecoveryCandidate[] = [];
  for (const trip of trips) {
    if (out.length >= limit) break;
    const tripId = String(trip.id ?? "");
    if (!tripId) continue;
    if (!isPlatformCollectedModel(trip.financial_model)) continue;
    const driverId = String(trip.driver_id ?? "").trim();
    if (!driverId) continue;
    const expected = expectedTenCreditFromSavedStamps(trip);
    if (expected <= 0) continue;

    const ten = await readTripEarningNetLedgerState(supabase, tripId).catch(() => ({
      count: 0,
      totalPence: 0,
      rows: [],
    }));
    if (ten.count > 0) continue;

    const gate = await loadPaymentSessionCaptureGate(supabase, tripId);
    if (gate.error || gate.gate_status !== PAYMENT_SESSION_GATE_STATUS.OK) continue;
    if (!paymentSessionAllowsWalletPosting(gate.session)) continue;

    out.push({
      trip_id: tripId,
      trip_code: trip.trip_code ? String(trip.trip_code) : null,
      driver_id: driverId,
      driver_net_pence: Math.round(Number(trip.driver_net_pence) || 0),
      airport_charge_pence: Math.round(Number(trip.airport_charge_pence) || 0),
      expected_credit_pence: expected,
      payment_session_id: trip.payment_session_id
        ? String(trip.payment_session_id)
        : (gate.session?.id ? String(gate.session.id) : null),
      captured_amount_pence: Math.round(
        Number(gate.session?.captured_amount_pence) || 0,
      ),
    });
  }
  return out;
}

export async function recoverMissingTripEarningNet(
  supabase: SupabaseClient,
  args: {
    tripId: string;
    dryRun?: boolean;
    /** Test/ops override — production incomplete heal uses epoch (post-activation). */
    activatedAtMs?: number;
  },
): Promise<MissingTenRecoveryResult> {
  const tripId = String(args.tripId ?? "").trim();
  const dryRun = args.dryRun === true;
  const activatedAtMs = args.activatedAtMs ?? INCOMPLETE_SETTLEMENT_RECOVERY_ACTIVATED_AT_MS;

  const { data: tripRow } = await supabase
    .from("trips")
    .select(
      "id, trip_code, driver_id, driver_net_pence, airport_charge_pence, financial_model, status, payment_status, tip_pence, tip_amount_pence, currency_code, currency, provider_order_id, accepted_commission_percent, driver_tier_commission_percent, commission_pct, created_at",
    )
    .eq("id", tripId)
    .maybeSingle();

  const trip = (tripRow ?? null) as Record<string, unknown> | null;
  const tripCode = trip?.trip_code ? String(trip.trip_code) : null;

  if (!trip) {
    return { trip_id: tripId, trip_code: null, status: "FAILED", reason: "trip_not_found" };
  }
  if (!isPlatformCollectedModel(trip.financial_model)) {
    return {
      trip_id: tripId,
      trip_code: tripCode,
      status: "SKIPPED_MODEL",
      reason: String(trip.financial_model ?? ""),
    };
  }
  const driverId = String(trip.driver_id ?? "").trim();
  if (!driverId) {
    return { trip_id: tripId, trip_code: tripCode, status: "SKIPPED_NO_DRIVER" };
  }
  const expected = expectedTenCreditFromSavedStamps(trip);
  if (expected <= 0) {
    return { trip_id: tripId, trip_code: tripCode, status: "SKIPPED_NO_ENTITLEMENT" };
  }

  const ten = await readTripEarningNetLedgerState(supabase, tripId).catch(() => ({
    count: 0,
    totalPence: 0,
    rows: [],
  }));
  if (ten.count === 1 && ten.totalPence === expected) {
    return {
      trip_id: tripId,
      trip_code: tripCode,
      status: "ALREADY_CREDITED",
      expected_credit_pence: expected,
      posted_pence: ten.totalPence,
    };
  }
  if (ten.count > 0) {
    return {
      trip_id: tripId,
      trip_code: tripCode,
      status: "FAILED",
      reason: ten.count > 1 ? "duplicate_ten" : "ten_amount_mismatch",
      expected_credit_pence: expected,
      posted_pence: ten.totalPence,
    };
  }

  const gate = await loadPaymentSessionCaptureGate(supabase, tripId);
  if (gate.error || !paymentSessionAllowsWalletPosting(gate.session)) {
    return {
      trip_id: tripId,
      trip_code: tripCode,
      status: "SKIPPED_GATE",
      reason: gate.error?.message
        ?? gate.gate_status
        ?? "payment_session_capture_unverified",
      expected_credit_pence: expected,
    };
  }

  const captureAmount = Math.round(Number(gate.session?.captured_amount_pence) || 0);
  if (dryRun) {
    return {
      trip_id: tripId,
      trip_code: tripCode,
      status: "DRY_RUN_ELIGIBLE",
      expected_credit_pence: expected,
      reason: MISSING_TEN_RECOVERY_REASON,
    };
  }

  const posting = await applyCanonicalSettlementAfterCapture({
    supabase,
    tripId,
    trip,
    captureAmountPence: captureAmount,
    tipPence: Math.max(
      0,
      Math.round(Number(trip.tip_pence ?? trip.tip_amount_pence) || 0),
    ),
    mode: "recovery",
    activatedAtMs,
  });

  if (posting.wallet_posting_status === "SUCCEEDED") {
    return {
      trip_id: tripId,
      trip_code: tripCode,
      status: "CREDITED",
      expected_credit_pence: expected,
      posted_pence: posting.posted_driver_credit_pence,
      posting,
      reason: MISSING_TEN_RECOVERY_REASON,
    };
  }

  const after = await readTripEarningNetLedgerState(supabase, tripId).catch(() => ({
    count: 0,
    totalPence: 0,
    rows: [],
  }));
  if (after.count === 1 && after.totalPence === expected) {
    return {
      trip_id: tripId,
      trip_code: tripCode,
      status: "ALREADY_CREDITED",
      expected_credit_pence: expected,
      posted_pence: after.totalPence,
    };
  }

  return {
    trip_id: tripId,
    trip_code: tripCode,
    status: "FAILED",
    expected_credit_pence: expected,
    posted_pence: after.totalPence,
    posting,
    reason: posting.reconciliation_status ?? "wallet_posting_failed",
  };
}

export async function sweepRecoverMissingTripEarningNet(
  supabase: SupabaseClient,
  args?: { limit?: number; dryRun?: boolean },
): Promise<{
  scanned: number;
  results: MissingTenRecoveryResult[];
}> {
  const candidates = await findMissingTripEarningNetCandidates(supabase, {
    limit: args?.limit,
  });
  const results: MissingTenRecoveryResult[] = [];
  for (const c of candidates) {
    results.push(
      await recoverMissingTripEarningNet(supabase, {
        tripId: c.trip_id,
        dryRun: args?.dryRun === true,
      }),
    );
  }
  return { scanned: candidates.length, results };
}
