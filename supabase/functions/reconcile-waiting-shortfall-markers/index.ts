/**
 * Scheduled recovery for waiting-time shortfalls whose receivable was not saved.
 *
 * Reads the durable payment-session marker (or the ops alert written when that
 * marker could not be committed) and calls the idempotent receivable/exception
 * path. Does not call Revolut, does not capture, and does not create a second
 * debt when one already exists.
 */
import { createServiceRoleClient, serveWithEdgeTiming } from "../_shared/edgeFunctionTiming.ts";
import { assertCronOrServiceRoleAuth } from "../_shared/cronEdgeAuth.ts";
import {
  ensureShortfallReceivableOrException,
  selectShortfallRecoveryCandidates,
  SHORTFALL_SAFETY_STATE,
} from "../_shared/shortfallReceivableSafety.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-onecab-cron-secret",
  "Content-Type": "application/json",
};

const BATCH = 25;

serveWithEdgeTiming("reconcile-waiting-shortfall-markers", corsHeaders, async (req) => {
  const cronAuth = await assertCronOrServiceRoleAuth(req);
  if (!cronAuth.ok) return cronAuth.response;

  const supabase = createServiceRoleClient();
  const [sessionsRes, alertsRes, receivablesRes] = await Promise.all([
    supabase
      .from("payment_sessions")
      .select("id, trip_id, provider_order_id, status, provider_state, created_at, captured_amount_pence, metadata")
      .not("metadata->shortfall_pence", "is", null)
      .order("created_at", { ascending: true })
      .limit(BATCH),
    supabase
      .from("ops_alerts")
      .select("fingerprint, status, related_trip_id, metadata")
      .eq("status", "open")
      .like("fingerprint", "finance:shortfall_unrecorded:%")
      .limit(BATCH),
    supabase
      .from("customer_receivables")
      .select("source_trip_id")
      .limit(5000),
  ]);

  if (sessionsRes.error) {
    return new Response(JSON.stringify({ ok: false, error: sessionsRes.error.message }), {
      status: 500,
      headers: corsHeaders,
    });
  }

  const candidates = selectShortfallRecoveryCandidates({
    sessions: sessionsRes.data ?? [],
    alerts: alertsRes.error ? [] : (alertsRes.data ?? []),
    receivableTripIds: (receivablesRes.data ?? [])
      .map((row) => String((row as { source_trip_id?: string | null }).source_trip_id ?? ""))
      .filter(Boolean),
  }).slice(0, BATCH);

  const counts = {
    examined: candidates.length,
    receivable_recorded: 0,
    exception_recorded: 0,
    escalated: 0,
    not_required: 0,
    errors: 0,
  };

  for (const candidate of candidates) {
    try {
      let customerId = candidate.customerId;
      if (!customerId) {
        const { data: trip } = await supabase
          .from("trips")
          .select("passenger_id")
          .eq("id", candidate.tripId)
          .maybeSingle();
        customerId = trip?.passenger_id ? String(trip.passenger_id) : null;
      }
      const outcome = await ensureShortfallReceivableOrException(supabase, {
        trip_id: candidate.tripId,
        payment_session_id: candidate.sessionId,
        provider_order_id: candidate.providerOrderId,
        customer_id: customerId,
        expected_fare_pence: candidate.expectedFarePence,
        captured_pence: candidate.capturedPence,
        shortfall_pence: candidate.shortfallPence,
        currency: candidate.currency,
        provider_state: "COMPLETED",
        source: candidate.source === "session_marker"
          ? "already_captured_retry"
          : "uncommitted_marker_alert",
      });
      if (outcome.state === SHORTFALL_SAFETY_STATE.RECEIVABLE_RECORDED) counts.receivable_recorded += 1;
      else if (outcome.state === SHORTFALL_SAFETY_STATE.EXCEPTION_RECORDED) counts.exception_recorded += 1;
      else if (outcome.state === SHORTFALL_SAFETY_STATE.ESCALATED_UNRECORDED) counts.escalated += 1;
      else counts.not_required += 1;
    } catch (err) {
      counts.errors += 1;
      console.error("[reconcile-waiting-shortfall-markers] candidate failed", candidate.tripId, err);
    }
  }

  return new Response(JSON.stringify({
    ok: true,
    money_moved: false,
    provider_called: false,
    ...counts,
  }), { status: 200, headers: corsHeaders });
});
