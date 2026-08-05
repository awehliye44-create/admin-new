/**
 * sweep-revolut-stale-holds
 *
 * Fallback reconciliation safety net (cron every 5 min via public.sweep_revolut_stale_holds).
 * Re-runs the canonical terminal disposition resolver for unresolved terminal holds.
 *
 * Detects:
 * - Terminal non-completed still AUTHORISED
 * - Provider CANCELLED / COMPLETED with local AUTHORISED drift (via disposer retrieve)
 * - Pending disposition beyond grace (metadata.terminal_disposition_pending)
 * - Fee capture incomplete (local capture missing after provider COMPLETED)
 *
 * Excludes: completed, rematch/active, in-progress (started_at set → interrupted policy skip).
 * Supports dry_run and bounded batches.
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { assertCronOrServiceRoleAuth } from "../_shared/cronEdgeAuth.ts";
import { disposeTerminalTripPayment } from "../_shared/terminalTripPaymentDisposition.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-onecab-cron-secret",
};

const TERMINAL = new Set([
  "cancelled",
  "canceled",
  "customer_cancelled",
  "driver_cancelled",
  "expired",
  "expired_no_driver",
  "no_show",
  "failed",
  "declined",
]);

/** Pending disposition grace — after this, sweep retries and reports watchdog age. */
const PENDING_GRACE_MS = 5 * 60 * 1000;

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const auth = await assertCronOrServiceRoleAuth(req, body);
  if (!auth.ok) return auth.response;

  const dryRun = body.dry_run === true;
  const limit = Math.min(50, Math.max(1, Number(body.limit ?? 20)));

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { data: sessions, error } = await supabase
    .from("payment_sessions")
    .select(
      "id, trip_id, provider_order_id, authorised_amount_pence, captured_amount_pence, provider_state, created_at, metadata, currency",
    )
    .eq("purpose", "RIDE_BOOKING")
    .in("provider_state", ["AUTHORISED", "AUTHORIZED"])
    .not("provider_order_id", "is", null)
    .not("trip_id", "is", null)
    .order("created_at", { ascending: true })
    .limit(Math.min(150, limit * 5));

  if (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const sessionRows = sessions ?? [];
  const tripIds = [...new Set(sessionRows.map((s) => s.trip_id as string).filter(Boolean))];
  let tripById = new Map<string, { id: string; status: string; started_at: string | null }>();

  if (tripIds.length > 0) {
    const { data: trips, error: tripErr } = await supabase
      .from("trips")
      .select("id, status, started_at")
      .in("id", tripIds);
    if (tripErr) {
      return new Response(JSON.stringify({ success: false, error: tripErr.message }), {
        status: 500,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    tripById = new Map(
      (trips ?? []).map((t) => [t.id as string, t as { id: string; status: string; started_at: string | null }]),
    );
  }

  const nowMs = Date.now();
  const candidates = sessionRows.filter((s) => {
    const trip = tripById.get(s.trip_id as string);
    if (!trip) {
      // Authorised payment with no valid trip row — still candidate for dispose safety skip / orphan handling
      return true;
    }
    const status = String(trip.status ?? "").toLowerCase();
    if (status === "completed") return false;
    if (!TERMINAL.has(status)) return false;
    if (trip.started_at) return false;
    return true;
  }).slice(0, limit);

  const results: Array<Record<string, unknown>> = [];
  const watchdog: Array<Record<string, unknown>> = [];

  for (const row of candidates) {
    const tripId = row.trip_id as string;
    const trip = tripById.get(tripId);
    const meta = (row.metadata && typeof row.metadata === "object")
      ? row.metadata as Record<string, unknown>
      : {};
    const pendingAt = typeof meta.terminal_disposition_pending_at === "string"
      ? Date.parse(meta.terminal_disposition_pending_at)
      : NaN;
    const ageMs = nowMs - new Date(String(row.created_at)).getTime();
    const pendingStale = meta.terminal_disposition_pending === true &&
      Number.isFinite(pendingAt) &&
      (nowMs - pendingAt) > PENDING_GRACE_MS;

    if (dryRun) {
      results.push({
        trip_id: tripId,
        trip_status: trip?.status ?? null,
        dry_run: true,
        action: "would_dispose",
        auth_pence: row.authorised_amount_pence,
        order_mask: String(row.provider_order_id).slice(0, 8) + "…",
        pending_stale: pendingStale,
      });
      continue;
    }

    try {
      const result = await disposeTerminalTripPayment(supabase, {
        tripId,
        reason: "sweep_fallback",
      });
      results.push(result as unknown as Record<string, unknown>);

      if (
        result.outcome === "PROVIDER_PENDING_RECONCILIATION" ||
        result.outcome === "PROVIDER_FAILED" ||
        result.outcome === "LOCAL_RECONCILIATION_FAILED_AFTER_PROVIDER_SUCCESS" ||
        pendingStale
      ) {
        watchdog.push({
          provider: "revolut",
          currency: row.currency ?? "GBP",
          amount_pence: row.authorised_amount_pence,
          oldest_age_ms: ageMs,
          fee_category: result.decision?.disposition_reason ?? meta.terminal_disposition_reason ?? null,
          trip_status: trip?.status ?? null,
          failure_reason: result.message ?? result.outcome,
          trip_mask: tripId.slice(0, 8) + "…",
          order_mask: String(row.provider_order_id).slice(0, 8) + "…",
        });
      }
    } catch (e) {
      results.push({
        trip_id: tripId,
        outcome: "PROVIDER_FAILED",
        message: e instanceof Error ? e.message : String(e),
      });
      watchdog.push({
        provider: "revolut",
        currency: row.currency ?? "GBP",
        amount_pence: row.authorised_amount_pence,
        oldest_age_ms: ageMs,
        trip_status: trip?.status ?? null,
        failure_reason: e instanceof Error ? e.message : String(e),
        trip_mask: tripId.slice(0, 8) + "…",
      });
    }
  }

  // Watchdog rollup by currency (never mix currencies).
  const byCurrency: Record<string, { count: number; amount_pence: number; oldest_age_ms: number }> = {};
  for (const w of watchdog) {
    const cur = String(w.currency ?? "GBP");
    const bucket = byCurrency[cur] ?? { count: 0, amount_pence: 0, oldest_age_ms: 0 };
    bucket.count += 1;
    bucket.amount_pence += Number(w.amount_pence ?? 0);
    bucket.oldest_age_ms = Math.max(bucket.oldest_age_ms, Number(w.oldest_age_ms ?? 0));
    byCurrency[cur] = bucket;
  }

  return new Response(JSON.stringify({
    success: true,
    dry_run: dryRun,
    scanned_sessions: sessionRows.length,
    eligible: candidates.length,
    results,
    watchdog: {
      unresolved_count: watchdog.length,
      by_currency: byCurrency,
      samples: watchdog.slice(0, 20),
    },
  }), {
    status: 200,
    headers: { ...cors, "Content-Type": "application/json" },
  });
});
