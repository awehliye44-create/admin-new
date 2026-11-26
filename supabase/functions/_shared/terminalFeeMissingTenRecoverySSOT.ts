/**
 * #111A — Durable recovery for terminal-fee trips (no-show / fee cancellation)
 * with provider-confirmed capture but missing TRIP_EARNING_NET.
 *
 * Completed-only missing-TEN sweep cannot heal no_show / cancellation rows
 * (MK-261126-001). Resume is idempotent: stamp repair + exactly-once ledger.
 *
 * Lock: terminalFeeMissingTenRecoverySSOT.test.ts
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import { isPlatformCollectedModel } from "./missingTripEarningNetRecoverySSOT.ts";
import { readTripEarningNetLedgerState } from "./tripEarningNetLedgerReadback.ts";
import {
  maybeResumeTerminalFeeSettlementAfterProviderFee,
  type ResumeTerminalFeeSettlementResult,
} from "./terminalFeeSettlementResumptionSSOT.ts";
import { resolveTerminalOutcomeKind } from "./terminalOutcomeKindSSOT.ts";

export const TERMINAL_FEE_MISSING_TEN_RECOVERY_SOURCE =
  "sweep_terminal_fee_missing_ten_111a" as const;

const TERMINAL_FEE_STATUSES = [
  "no_show",
  "cancelled",
  "canceled",
  "customer_cancelled",
  "driver_cancelled",
] as const;

export type TerminalFeeMissingTenCandidate = {
  trip_id: string;
  trip_code: string | null;
  status: string;
  payment_session_id: string | null;
  captured_amount_pence: number;
};

export type TerminalFeeMissingTenResult = {
  trip_id: string;
  trip_code: string | null;
  status:
    | "CREDITED"
    | "ALREADY_CREDITED"
    | "STAMP_REPAIRED"
    | "PENDING"
    | "SKIPPED"
    | "FAILED"
    | "DRY_RUN_ELIGIBLE";
  reason?: string;
  entitlement_pence?: number | null;
  resume?: ResumeTerminalFeeSettlementResult;
};

/**
 * Bounded cohort: captured Payment Sessions → PLATFORM_COLLECTED terminal-fee
 * trips with no TEN. Oldest unresolved first.
 */
export async function findTerminalFeeMissingTenCandidates(
  supabase: SupabaseClient,
  args?: { limit?: number },
): Promise<TerminalFeeMissingTenCandidate[]> {
  const limit = Math.min(50, Math.max(1, Number(args?.limit ?? 20)));
  const lookbackIso = new Date(Date.now() - 14 * 24 * 3600_000).toISOString();

  const { data: sessions, error: sessErr } = await supabase
    .from("payment_sessions")
    .select("id, trip_id, captured_amount_pence, updated_at")
    .gt("captured_amount_pence", 0)
    .not("trip_id", "is", null)
    .gte("updated_at", lookbackIso)
    .order("updated_at", { ascending: true })
    .limit(Math.max(limit * 8, 80));

  if (sessErr || !Array.isArray(sessions) || sessions.length === 0) return [];

  const tripIds = [
    ...new Set(
      sessions
        .map((s) => String(s.trip_id ?? "").trim())
        .filter(Boolean),
    ),
  ];
  if (tripIds.length === 0) return [];

  const { data: trips, error } = await supabase
    .from("trips")
    .select(
      "id, trip_code, driver_id, financial_model, financial_outcome, status, payment_status, no_show_charge_pence, cancellation_fee_pence, payment_session_id",
    )
    .in("id", tripIds)
    .in("status", [...TERMINAL_FEE_STATUSES])
    .eq("financial_model", "PLATFORM_COLLECTED");

  if (error || !Array.isArray(trips) || trips.length === 0) return [];

  const tripById = new Map(trips.map((t) => [String(t.id), t]));
  const ordered: typeof trips = [];
  const seen = new Set<string>();
  for (const s of sessions) {
    const id = String(s.trip_id ?? "");
    if (!id || seen.has(id)) continue;
    const trip = tripById.get(id);
    if (!trip) continue;
    seen.add(id);
    ordered.push(trip);
  }

  const out: TerminalFeeMissingTenCandidate[] = [];
  for (const trip of ordered) {
    if (out.length >= limit) break;
    const tripId = String(trip.id ?? "");
    if (!tripId) continue;
    const payStatus = String(trip.payment_status ?? "").toLowerCase();
    if (
      payStatus === "refunded"
      || payStatus === "voided"
      || payStatus === "released"
      || payStatus.includes("refund")
    ) {
      continue;
    }
    if (!isPlatformCollectedModel(trip.financial_model)) continue;
    if (!resolveTerminalOutcomeKind(trip as {
      status?: string | null;
      financial_outcome?: string | null;
      payment_status?: string | null;
      no_show_charge_pence?: number | null;
      cancellation_fee_pence?: number | null;
    })) {
      continue;
    }

    const ten = await readTripEarningNetLedgerState(supabase, tripId).catch(() => ({
      count: 0,
      totalPence: 0,
      rows: [],
    }));
    if (ten.count > 0) continue;

    const session = sessions.find((s) => String(s.trip_id) === tripId);
    out.push({
      trip_id: tripId,
      trip_code: trip.trip_code ? String(trip.trip_code) : null,
      status: String(trip.status ?? ""),
      payment_session_id: trip.payment_session_id
        ? String(trip.payment_session_id)
        : (session?.id ? String(session.id) : null),
      captured_amount_pence: Math.round(
        Number(session?.captured_amount_pence) || 0,
      ),
    });
  }
  return out;
}

export async function recoverTerminalFeeMissingTen(
  supabase: SupabaseClient,
  args: { tripId: string; dryRun?: boolean },
): Promise<TerminalFeeMissingTenResult> {
  const tripId = String(args.tripId ?? "").trim();
  const dryRun = args.dryRun === true;

  const { data: tripRow } = await supabase
    .from("trips")
    .select(
      "id, trip_code, financial_model, financial_outcome, status, payment_status, no_show_charge_pence, cancellation_fee_pence",
    )
    .eq("id", tripId)
    .maybeSingle();

  const trip = (tripRow ?? null) as Record<string, unknown> | null;
  const tripCode = trip?.trip_code ? String(trip.trip_code) : null;

  if (!trip) {
    return { trip_id: tripId, trip_code: null, status: "FAILED", reason: "trip_not_found" };
  }
  const payStatus = String(trip.payment_status ?? "").toLowerCase();
  if (
    payStatus === "refunded"
    || payStatus === "voided"
    || payStatus === "released"
    || payStatus.includes("refund")
  ) {
    return {
      trip_id: tripId,
      trip_code: tripCode,
      status: "SKIPPED",
      reason: "payment_refunded_or_released",
    };
  }
  if (!isPlatformCollectedModel(trip.financial_model)) {
    return {
      trip_id: tripId,
      trip_code: tripCode,
      status: "SKIPPED",
      reason: "financial_model_not_platform_collected",
    };
  }
  if (!resolveTerminalOutcomeKind(trip as {
    status?: string | null;
    financial_outcome?: string | null;
    payment_status?: string | null;
    no_show_charge_pence?: number | null;
    cancellation_fee_pence?: number | null;
  })) {
    return {
      trip_id: tripId,
      trip_code: tripCode,
      status: "SKIPPED",
      reason: "not_terminal_fee_trip",
    };
  }

  const ten = await readTripEarningNetLedgerState(supabase, tripId).catch(() => ({
    count: 0,
    totalPence: 0,
    rows: [],
  }));
  if (ten.count > 0) {
    // Still run resume so stamp can repair after credit (alreadyPosted path).
    if (!dryRun) {
      const resume = await maybeResumeTerminalFeeSettlementAfterProviderFee(supabase, {
        tripId,
        source: TERMINAL_FEE_MISSING_TEN_RECOVERY_SOURCE,
      });
      return {
        trip_id: tripId,
        trip_code: tripCode,
        status: resume.reason === "stamp_repaired_after_credit"
          ? "STAMP_REPAIRED"
          : "ALREADY_CREDITED",
        reason: resume.reason,
        entitlement_pence: resume.entitlement_pence,
        resume,
      };
    }
    return {
      trip_id: tripId,
      trip_code: tripCode,
      status: "ALREADY_CREDITED",
      entitlement_pence: ten.totalPence,
    };
  }

  if (dryRun) {
    return {
      trip_id: tripId,
      trip_code: tripCode,
      status: "DRY_RUN_ELIGIBLE",
      reason: "terminal_fee_capture_missing_ten",
    };
  }

  const resume = await maybeResumeTerminalFeeSettlementAfterProviderFee(supabase, {
    tripId,
    source: TERMINAL_FEE_MISSING_TEN_RECOVERY_SOURCE,
  });

  if (resume.credited) {
    return {
      trip_id: tripId,
      trip_code: tripCode,
      status: "CREDITED",
      reason: resume.reason,
      entitlement_pence: resume.entitlement_pence,
      resume,
    };
  }
  if (resume.already_credited) {
    return {
      trip_id: tripId,
      trip_code: tripCode,
      status: resume.reason === "stamp_repaired_after_credit"
        ? "STAMP_REPAIRED"
        : "ALREADY_CREDITED",
      reason: resume.reason,
      entitlement_pence: resume.entitlement_pence,
      resume,
    };
  }
  if (resume.pending) {
    return {
      trip_id: tripId,
      trip_code: tripCode,
      status: "PENDING",
      reason: resume.reason,
      resume,
    };
  }
  return {
    trip_id: tripId,
    trip_code: tripCode,
    status: "FAILED",
    reason: resume.reason ?? "resume_failed",
    resume,
  };
}

export async function sweepRecoverTerminalFeeMissingTen(
  supabase: SupabaseClient,
  args?: { limit?: number; dryRun?: boolean },
): Promise<{
  scanned: number;
  results: TerminalFeeMissingTenResult[];
}> {
  const candidates = await findTerminalFeeMissingTenCandidates(supabase, {
    limit: args?.limit,
  });
  const results: TerminalFeeMissingTenResult[] = [];
  for (const c of candidates) {
    results.push(
      await recoverTerminalFeeMissingTen(supabase, {
        tripId: c.trip_id,
        dryRun: args?.dryRun === true,
      }),
    );
  }
  return { scanned: candidates.length, results };
}
