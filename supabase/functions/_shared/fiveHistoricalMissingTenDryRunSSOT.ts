/**
 * Step 9.2C1/C2 — five-trip historical missing-TEN recovery SSOT.
 * Dry-run eligibility + one-time approved credit via creditCapturedCardTripLedger.
 * Never touches PS/trips/stamps/provider/payouts/FR repairs.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  sessionLooksCaptured,
  sessionIsTerminalNonCapture,
} from "./missingTripEarningNetDetectSSOT.ts";
import { creditCapturedCardTripLedger } from "./onecabFinanceLedger.ts";

/** Exact five approved trip UUIDs (Step 9.2B2/B3 evidence). */
export const FIVE_HISTORICAL_MISSING_TEN_ALLOWLIST = {
  "ddc88920-1da3-4d2f-a85c-8de61a62d692": {
    trip_code: "MK-260805-016",
    driver_id: "5ed232c3-8bb5-4085-95d6-73e48e6c5e28",
    approved_amount_pence: 425,
  },
  "49883300-872b-42e5-917b-542f9deaf772": {
    trip_code: "MK-260808-053",
    driver_id: "5ed232c3-8bb5-4085-95d6-73e48e6c5e28",
    approved_amount_pence: 382,
  },
  "e594e764-c108-4b67-8a6e-80934019df2f": {
    trip_code: "MK-260808-054",
    driver_id: "5ed232c3-8bb5-4085-95d6-73e48e6c5e28",
    approved_amount_pence: 670,
  },
  "32315218-b0b3-44d2-bf4c-cfa7c5619acc": {
    trip_code: "MK-260810-011",
    driver_id: "cd8bae4c-3827-4b90-98c6-10be70eb0e52",
    approved_amount_pence: 744,
  },
  "229223e3-c100-495d-afd8-2c39a3acf6b2": {
    trip_code: "MK-260818-001",
    driver_id: "cd8bae4c-3827-4b90-98c6-10be70eb0e52",
    approved_amount_pence: 408,
  },
} as const;

export const FIVE_HISTORICAL_MISSING_TEN_IDS = Object.keys(
  FIVE_HISTORICAL_MISSING_TEN_ALLOWLIST,
) as ReadonlyArray<keyof typeof FIVE_HISTORICAL_MISSING_TEN_ALLOWLIST>;

export const APPROVED_TOTAL_PENCE = 2629;

/** Explicitly excluded PENDING_EVIDENCE trip — must never be credited via this path. */
export const EXCLUDED_PENDING_MK008_TRIP_ID = "3b48b86c-9ebf-407e-bb8b-a51ad2e75edc";

export const LIVE_EXECUTION_DISABLED = "LIVE_EXECUTION_DISABLED";
export const ALLOWLIST_VIOLATION = "ALLOWLIST_VIOLATION";
export const RECOVERY_PRECONDITION_FAILED = "RECOVERY_PRECONDITION_FAILED";
export const CREDIT_CONFLICT = "CREDIT_CONFLICT";
export const LIFECYCLE_CONFLICT = "LIFECYCLE_CONFLICT";

/** Exact confirmation required for Step 9.2C2 live credit. */
export const CONFIRM_EXECUTE_PHRASE = "CREDIT_FIVE_SAVED_TRIP_EARNINGS_2629P";

export type DryRunEligibleRow = {
  trip_id: string;
  trip_code: string;
  driver_id: string;
  classification: "DRY_RUN_ELIGIBLE";
  entitlement_pence: number;
  proposed_ten_amount_pence: number;
  existing_ten_count: number;
  existing_ten_sum_pence: number;
  payment_session_id: string;
  provider_state: string | null;
  captured_amount_pence: number | null;
  economic_earned_at: string;
  economic_date_status: "CANONICAL_CAPTURED_AT";
  posting_created_at: null;
  provider_operation_required: false;
  settlement_recalculation_required: false;
  wallet_mutation_performed: false;
};

export type AllowlistGate =
  | { ok: true; trip_ids: string[] }
  | { ok: false; error: typeof ALLOWLIST_VIOLATION; message: string };

/** Exact set equality against the five approved UUIDs (order-independent). */
export function gateExactFiveTripAllowlist(tripIds: unknown): AllowlistGate {
  if (!Array.isArray(tripIds)) {
    return { ok: false, error: ALLOWLIST_VIOLATION, message: "trip_ids must be an array of exactly five approved UUIDs" };
  }
  const ids = tripIds.map((x) => String(x ?? "").trim().toLowerCase());
  if (ids.some((id) => !id)) {
    return { ok: false, error: ALLOWLIST_VIOLATION, message: "trip_ids contains empty/missing id" };
  }
  if (ids.includes(EXCLUDED_PENDING_MK008_TRIP_ID)) {
    return { ok: false, error: ALLOWLIST_VIOLATION, message: "MK-260817-008 is PENDING_EVIDENCE and is excluded from recovery" };
  }
  const unique = new Set(ids);
  if (unique.size !== ids.length) {
    return { ok: false, error: ALLOWLIST_VIOLATION, message: "trip_ids contains duplicates" };
  }
  if (ids.length !== FIVE_HISTORICAL_MISSING_TEN_IDS.length) {
    return {
      ok: false,
      error: ALLOWLIST_VIOLATION,
      message: `expected exactly ${FIVE_HISTORICAL_MISSING_TEN_IDS.length} trip_ids, got ${ids.length}`,
    };
  }
  const allowed = new Set(FIVE_HISTORICAL_MISSING_TEN_IDS.map((x) => x.toLowerCase()));
  for (const id of ids) {
    if (!allowed.has(id)) {
      return { ok: false, error: ALLOWLIST_VIOLATION, message: `unknown or mixed trip_id not on allow-list: ${id}` };
    }
  }
  for (const need of allowed) {
    if (!unique.has(need)) {
      return { ok: false, error: ALLOWLIST_VIOLATION, message: `missing approved trip_id: ${need}` };
    }
  }
  // Preserve canonical casing from allow-list
  return { ok: true, trip_ids: [...FIVE_HISTORICAL_MISSING_TEN_IDS] };
}

export function isApprovedLiveExecute(body: Record<string, unknown>): boolean {
  return body.dry_run === false && body.confirm_execute === CONFIRM_EXECUTE_PHRASE;
}

/** True when caller attempts live credit without the exact approved confirmation. */
export function isLiveExecutionRequest(body: Record<string, unknown>): boolean {
  if (isApprovedLiveExecute(body)) return false;
  if (body.dry_run === false) return true;
  if (body.confirm != null || body.confirm_execute != null || body.confirm_detect != null) return true;
  if (body.execute === true || body.repair === true || body.insert_ten === true || body.credit === true) {
    return true;
  }
  if (body.mode === "execute" || body.mode === "live" || body.mode === "credit") return true;
  return false;
}

type PsRow = {
  id: string;
  purpose: string | null;
  status: string | null;
  provider_state: string | null;
  provider_order_id: string | null;
  provider_capture_id: string | null;
  captured_amount_pence: number | null;
  captured_at: string | null;
  financial_operation_state: string | null;
  released_amount_pence: number | null;
  refunded_amount_pence: number | null;
};

async function tenStats(supabase: SupabaseClient, tripId: string): Promise<{ count: number; sum: number } | null> {
  const { data, error } = await supabase
    .from("driver_wallet_ledger")
    .select("amount_pence")
    .eq("related_trip_id", tripId)
    .eq("type", "TRIP_EARNING_NET");
  if (error) return null;
  const rows = data ?? [];
  return {
    count: rows.length,
    sum: rows.reduce((s, r) => s + Math.round(Number((r as { amount_pence: number }).amount_pence) || 0), 0),
  };
}

async function commissionWalletCount(supabase: SupabaseClient, tripId: string): Promise<number | null> {
  const { count, error } = await supabase
    .from("driver_commission_wallet_ledger")
    .select("id", { count: "exact", head: true })
    .eq("trip_id", tripId);
  if (error) return null;
  return count ?? 0;
}

export async function evaluateFiveTripDryRun(
  supabase: SupabaseClient,
  tripIds: string[],
): Promise<
  | {
    ok: true;
    trips: DryRunEligibleRow[];
    proposed_total_pence: number;
    credited_total_pence: 0;
    provider_operation_required: false;
    settlement_recalculation_required: false;
    money_mutation: "ZERO";
  }
  | { ok: false; error: typeof RECOVERY_PRECONDITION_FAILED; message: string; trip_id?: string }
> {
  const results: DryRunEligibleRow[] = [];

  for (const tripId of tripIds) {
    const expected = FIVE_HISTORICAL_MISSING_TEN_ALLOWLIST[
      tripId as keyof typeof FIVE_HISTORICAL_MISSING_TEN_ALLOWLIST
    ];
    if (!expected) {
      return { ok: false, error: RECOVERY_PRECONDITION_FAILED, message: "allow-list miss during evaluate", trip_id: tripId };
    }

    const { data: trip, error: tripErr } = await supabase
      .from("trips")
      .select(
        "id, trip_code, driver_id, financial_model, status, completed_at, driver_net_pence",
      )
      .eq("id", tripId)
      .maybeSingle();
    if (tripErr || !trip) {
      return {
        ok: false,
        error: RECOVERY_PRECONDITION_FAILED,
        message: `trip not found: ${tripErr?.message ?? "missing"}`,
        trip_id: tripId,
      };
    }
    if (String(trip.trip_code) !== expected.trip_code) {
      return { ok: false, error: RECOVERY_PRECONDITION_FAILED, message: "trip_code mismatch", trip_id: tripId };
    }
    if (String(trip.driver_id) !== expected.driver_id) {
      return { ok: false, error: RECOVERY_PRECONDITION_FAILED, message: "driver_id mismatch", trip_id: tripId };
    }
    if (String(trip.financial_model) !== "PLATFORM_COLLECTED") {
      return { ok: false, error: RECOVERY_PRECONDITION_FAILED, message: "financial_model not PLATFORM_COLLECTED", trip_id: tripId };
    }
    if (String(trip.status) !== "completed") {
      return { ok: false, error: RECOVERY_PRECONDITION_FAILED, message: "trip not completed", trip_id: tripId };
    }
    const stamp = Math.round(Number(trip.driver_net_pence));
    if (!Number.isFinite(stamp) || stamp !== expected.approved_amount_pence) {
      return {
        ok: false,
        error: RECOVERY_PRECONDITION_FAILED,
        message: `saved entitlement ${trip.driver_net_pence} != approved ${expected.approved_amount_pence}`,
        trip_id: tripId,
      };
    }

    const { data: sessions, error: psErr } = await supabase
      .from("payment_sessions")
      .select(
        "id, purpose, status, provider_state, provider_order_id, provider_capture_id, captured_amount_pence, captured_at, financial_operation_state, released_amount_pence, refunded_amount_pence",
      )
      .eq("trip_id", tripId)
      .eq("purpose", "RIDE_BOOKING")
      .order("created_at", { ascending: true });
    if (psErr) {
      return { ok: false, error: RECOVERY_PRECONDITION_FAILED, message: psErr.message, trip_id: tripId };
    }
    const rb = (sessions ?? []) as PsRow[];
    if (rb.length === 0) {
      return { ok: false, error: RECOVERY_PRECONDITION_FAILED, message: "zero RIDE_BOOKING", trip_id: tripId };
    }
    if (rb.length !== 1) {
      return {
        ok: false,
        error: RECOVERY_PRECONDITION_FAILED,
        message: `multiple RIDE_BOOKING count=${rb.length}`,
        trip_id: tripId,
      };
    }
    const ps = rb[0];
    if (sessionIsTerminalNonCapture(ps) || !sessionLooksCaptured(ps)) {
      return {
        ok: false,
        error: RECOVERY_PRECONDITION_FAILED,
        message: "capture not verified completed / terminal non-capture",
        trip_id: tripId,
      };
    }
    if (!ps.captured_at) {
      return { ok: false, error: RECOVERY_PRECONDITION_FAILED, message: "captured_at missing", trip_id: tripId };
    }
    if (!ps.provider_order_id && !ps.provider_capture_id) {
      return { ok: false, error: RECOVERY_PRECONDITION_FAILED, message: "provider capture identity missing", trip_id: tripId };
    }

    const ten = await tenStats(supabase, tripId);
    if (ten == null) {
      return { ok: false, error: RECOVERY_PRECONDITION_FAILED, message: "TEN query failed", trip_id: tripId };
    }
    if (ten.count !== 0 || ten.sum !== 0) {
      return {
        ok: false,
        error: RECOVERY_PRECONDITION_FAILED,
        message: `existing TEN count=${ten.count} sum=${ten.sum}`,
        trip_id: tripId,
      };
    }

    const cw = await commissionWalletCount(supabase, tripId);
    if (cw == null) {
      return { ok: false, error: RECOVERY_PRECONDITION_FAILED, message: "CW query failed", trip_id: tripId };
    }
    if (cw > 0) {
      return { ok: false, error: RECOVERY_PRECONDITION_FAILED, message: "Commission Wallet row present", trip_id: tripId };
    }

    // Any other wallet credit for this trip blocks (compensation / alternate credit).
    const { data: otherLedger, error: olErr } = await supabase
      .from("driver_wallet_ledger")
      .select("id, type, amount_pence")
      .eq("related_trip_id", tripId);
    if (olErr) {
      return { ok: false, error: RECOVERY_PRECONDITION_FAILED, message: olErr.message, trip_id: tripId };
    }
    if ((otherLedger ?? []).length > 0) {
      return {
        ok: false,
        error: RECOVERY_PRECONDITION_FAILED,
        message: "existing wallet/compensation rows for trip",
        trip_id: tripId,
      };
    }

    results.push({
      trip_id: tripId,
      trip_code: expected.trip_code,
      driver_id: expected.driver_id,
      classification: "DRY_RUN_ELIGIBLE",
      entitlement_pence: expected.approved_amount_pence,
      proposed_ten_amount_pence: expected.approved_amount_pence,
      existing_ten_count: 0,
      existing_ten_sum_pence: 0,
      payment_session_id: ps.id,
      provider_state: ps.provider_state,
      captured_amount_pence: ps.captured_amount_pence == null
        ? null
        : Math.round(Number(ps.captured_amount_pence)),
      economic_earned_at: String(ps.captured_at),
      economic_date_status: "CANONICAL_CAPTURED_AT",
      posting_created_at: null,
      provider_operation_required: false,
      settlement_recalculation_required: false,
      wallet_mutation_performed: false,
    });
  }

  const proposed = results.reduce((s, r) => s + r.proposed_ten_amount_pence, 0);
  // Full five-trip dry-run must total 2629p; single-trip revalidation (credit path) skips total gate.
  if (tripIds.length === FIVE_HISTORICAL_MISSING_TEN_IDS.length && proposed !== APPROVED_TOTAL_PENCE) {
    return {
      ok: false,
      error: RECOVERY_PRECONDITION_FAILED,
      message: `proposed total ${proposed} != ${APPROVED_TOTAL_PENCE}`,
    };
  }

  return {
    ok: true,
    trips: results,
    proposed_total_pence: proposed,
    credited_total_pence: 0,
    provider_operation_required: false,
    settlement_recalculation_required: false,
    money_mutation: "ZERO",
  };
}

export type CreditTripResult = {
  trip_id: string;
  trip_code: string;
  driver_id: string;
  status: "CREDITED" | "ALREADY_CREDITED" | "CREDIT_FAILED" | "CREDIT_CONFLICT" | "LIFECYCLE_CONFLICT";
  credited_pence: number;
  entitlement_pence: number;
  economic_earned_at: string;
  posting_created_at: string | null;
  ten_count: number;
  error?: string;
};

async function readTenRows(
  supabase: SupabaseClient,
  tripId: string,
): Promise<Array<{ id: string; driver_id: string; amount_pence: number; created_at: string }>> {
  const { data, error } = await supabase
    .from("driver_wallet_ledger")
    .select("id, driver_id, amount_pence, created_at")
    .eq("related_trip_id", tripId)
    .eq("type", "TRIP_EARNING_NET");
  if (error) throw error;
  return (data ?? []).map((r) => ({
    id: String(r.id),
    driver_id: String(r.driver_id),
    amount_pence: Math.round(Number(r.amount_pence) || 0),
    created_at: String(r.created_at),
  }));
}

/**
 * Credit one allow-listed trip after fresh revalidation.
 * Uses canonical creditCapturedCardTripLedger (tip=0). Unique index enforces one TEN/trip.
 */
export async function creditOneApprovedTrip(
  supabase: SupabaseClient,
  tripId: string,
): Promise<CreditTripResult> {
  const expected = FIVE_HISTORICAL_MISSING_TEN_ALLOWLIST[
    tripId as keyof typeof FIVE_HISTORICAL_MISSING_TEN_ALLOWLIST
  ];
  if (!expected) {
    return {
      trip_id: tripId,
      trip_code: "UNKNOWN",
      driver_id: "",
      status: "CREDIT_FAILED",
      credited_pence: 0,
      entitlement_pence: 0,
      economic_earned_at: "",
      posting_created_at: null,
      ten_count: 0,
      error: "not on allow-list",
    };
  }

  // Fresh eligibility re-read (same fail-closed contract as dry-run).
  const dry = await evaluateFiveTripDryRun(supabase, [tripId]);
  if (!dry.ok) {
    // Existing TEN may cause dry-run failure — classify ALREADY_CREDITED vs conflict.
    const rows = await readTenRows(supabase, tripId).catch(() => []);
    if (rows.length === 1) {
      const row = rows[0];
      if (row.amount_pence === expected.approved_amount_pence && row.driver_id === expected.driver_id) {
        return {
          trip_id: tripId,
          trip_code: expected.trip_code,
          driver_id: expected.driver_id,
          status: "ALREADY_CREDITED",
          credited_pence: 0,
          entitlement_pence: expected.approved_amount_pence,
          economic_earned_at: "",
          posting_created_at: row.created_at,
          ten_count: 1,
        };
      }
      return {
        trip_id: tripId,
        trip_code: expected.trip_code,
        driver_id: expected.driver_id,
        status: "CREDIT_CONFLICT",
        credited_pence: 0,
        entitlement_pence: expected.approved_amount_pence,
        economic_earned_at: "",
        posting_created_at: row.created_at,
        ten_count: rows.length,
        error: `existing TEN amount/driver mismatch: ${row.amount_pence}p driver=${row.driver_id}`,
      };
    }
    if (rows.length > 1) {
      return {
        trip_id: tripId,
        trip_code: expected.trip_code,
        driver_id: expected.driver_id,
        status: "LIFECYCLE_CONFLICT",
        credited_pence: 0,
        entitlement_pence: expected.approved_amount_pence,
        economic_earned_at: "",
        posting_created_at: null,
        ten_count: rows.length,
        error: "duplicate TEN rows",
      };
    }
    return {
      trip_id: tripId,
      trip_code: expected.trip_code,
      driver_id: expected.driver_id,
      status: "CREDIT_FAILED",
      credited_pence: 0,
      entitlement_pence: expected.approved_amount_pence,
      economic_earned_at: "",
      posting_created_at: null,
      ten_count: 0,
      error: dry.message,
    };
  }

  const eligible = dry.trips[0];
  try {
    const before = await readTenRows(supabase, tripId);
    if (before.length === 1) {
      const row = before[0];
      if (row.amount_pence === expected.approved_amount_pence && row.driver_id === expected.driver_id) {
        return {
          trip_id: tripId,
          trip_code: expected.trip_code,
          driver_id: expected.driver_id,
          status: "ALREADY_CREDITED",
          credited_pence: 0,
          entitlement_pence: expected.approved_amount_pence,
          economic_earned_at: eligible.economic_earned_at,
          posting_created_at: row.created_at,
          ten_count: 1,
        };
      }
      return {
        trip_id: tripId,
        trip_code: expected.trip_code,
        driver_id: expected.driver_id,
        status: "CREDIT_CONFLICT",
        credited_pence: 0,
        entitlement_pence: expected.approved_amount_pence,
        economic_earned_at: eligible.economic_earned_at,
        posting_created_at: row.created_at,
        ten_count: 1,
        error: "pre-insert TEN conflict",
      };
    }

    await creditCapturedCardTripLedger(supabase, {
      driverId: expected.driver_id,
      tripId,
      driverNetPence: expected.approved_amount_pence,
      tipPence: 0,
      currency: "GBP",
      paymentId: null,
    });

    const after = await readTenRows(supabase, tripId);
    if (after.length !== 1) {
      return {
        trip_id: tripId,
        trip_code: expected.trip_code,
        driver_id: expected.driver_id,
        status: after.length > 1 ? "LIFECYCLE_CONFLICT" : "CREDIT_FAILED",
        credited_pence: 0,
        entitlement_pence: expected.approved_amount_pence,
        economic_earned_at: eligible.economic_earned_at,
        posting_created_at: after[0]?.created_at ?? null,
        ten_count: after.length,
        error: `post-credit TEN count=${after.length}`,
      };
    }
    const row = after[0];
    if (row.amount_pence !== expected.approved_amount_pence || row.driver_id !== expected.driver_id) {
      return {
        trip_id: tripId,
        trip_code: expected.trip_code,
        driver_id: expected.driver_id,
        status: "CREDIT_CONFLICT",
        credited_pence: 0,
        entitlement_pence: expected.approved_amount_pence,
        economic_earned_at: eligible.economic_earned_at,
        posting_created_at: row.created_at,
        ten_count: 1,
        error: "post-credit amount/driver mismatch",
      };
    }

    const wasNew = before.length === 0;
    return {
      trip_id: tripId,
      trip_code: expected.trip_code,
      driver_id: expected.driver_id,
      status: wasNew ? "CREDITED" : "ALREADY_CREDITED",
      credited_pence: wasNew ? expected.approved_amount_pence : 0,
      entitlement_pence: expected.approved_amount_pence,
      economic_earned_at: eligible.economic_earned_at,
      posting_created_at: row.created_at,
      ten_count: 1,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = (err as { code?: string })?.code;
    // Unique race → re-read
    if (code === "23505" || /duplicate|unique/i.test(message)) {
      const rows = await readTenRows(supabase, tripId).catch(() => []);
      if (
        rows.length === 1 &&
        rows[0].amount_pence === expected.approved_amount_pence &&
        rows[0].driver_id === expected.driver_id
      ) {
        return {
          trip_id: tripId,
          trip_code: expected.trip_code,
          driver_id: expected.driver_id,
          status: "ALREADY_CREDITED",
          credited_pence: 0,
          entitlement_pence: expected.approved_amount_pence,
          economic_earned_at: eligible.economic_earned_at,
          posting_created_at: rows[0].created_at,
          ten_count: 1,
        };
      }
    }
    return {
      trip_id: tripId,
      trip_code: expected.trip_code,
      driver_id: expected.driver_id,
      status: "CREDIT_FAILED",
      credited_pence: 0,
      entitlement_pence: expected.approved_amount_pence,
      economic_earned_at: eligible.economic_earned_at,
      posting_created_at: null,
      ten_count: 0,
      error: message,
    };
  }
}

export async function executeFiveTripCredit(
  supabase: SupabaseClient,
  tripIds: string[],
): Promise<{
  trips: CreditTripResult[];
  credited_total_pence: number;
  already_credited_count: number;
  credited_count: number;
  failed_count: number;
  provider_operation_required: false;
  settlement_recalculation_required: false;
}> {
  const trips: CreditTripResult[] = [];
  for (const id of tripIds) {
    trips.push(await creditOneApprovedTrip(supabase, id));
  }
  return {
    trips,
    credited_total_pence: trips.reduce((s, t) => s + t.credited_pence, 0),
    already_credited_count: trips.filter((t) => t.status === "ALREADY_CREDITED").length,
    credited_count: trips.filter((t) => t.status === "CREDITED").length,
    failed_count: trips.filter((t) =>
      t.status === "CREDIT_FAILED" || t.status === "CREDIT_CONFLICT" || t.status === "LIFECYCLE_CONFLICT"
    ).length,
    provider_operation_required: false,
    settlement_recalculation_required: false,
  };
}

