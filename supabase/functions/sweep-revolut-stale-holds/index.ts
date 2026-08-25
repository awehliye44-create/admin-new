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
 * - Completed + AUTHORISED / capture_failed (retry finalize — never void the fare hold)
 *
 * Dispose excludes completed / rematch / active / in-progress (started_at set).
 * Supports dry_run and bounded batches.
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { assertCronOrServiceRoleAuth } from "../_shared/cronEdgeAuth.ts";
import { disposeTerminalTripPayment } from "../_shared/terminalTripPaymentDisposition.ts";
import {
  releaseHoldForPaymentSession,
  sessionAgeMs,
  summarizeHoldSweepItemOutcomes,
  TRIPLESS_AUTHORISED_HOLD_SWEEP_MIN_AGE_MS,
} from "../_shared/holdReleaseSSOT.ts";
import { applyCanonicalSettlementAfterCapture } from "../_shared/applyCanonicalSettlementAfterCapture.ts";
import { invokeFinalizeTripCapture } from "../_shared/invokeFinalizeTripCapture.ts";
import { getRevolutMerchantConfig, retrieveRevolutOrder } from "../_shared/revolutOrders.ts";
import {
  disposeOutcomeIndicatesFeeCapture,
  isChargedFeeOutcome,
  postChargedFeeTenViaRfo,
  resolveAssignedDriverId,
} from "../_shared/chargedTerminalFeeWalletSSOT.ts";

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

/** Avoid racing an in-flight complete_trip → finalize invoke. */
const COMPLETED_AUTHORISED_RETRY_GRACE_MS = 90_000;

const COMPLETED_CAPTURE_RETRY_PAYMENT_STATUSES = new Set([
  "capture_failed",
  "authorized",
  "authorised",
  "capture_requested",
  "preauth_authorized",
  "preauth_authorised",
  "preauth_created",
  "preauth_updated",
]);

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

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, serviceRoleKey);

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
    // Terminal cancelled/expired/no_show after Start Trip must still void
    // uncaptured auth (classifyTerminalHoldDisposition ignores started_at).
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
      const sweepRow: Record<string, unknown> = { ...(result as unknown as Record<string, unknown>) };

      // Fee captured during sweep → post TEN (idempotent). Closes capture-without-wallet gap.
      if (disposeOutcomeIndicatesFeeCapture(result)) {
        const { data: feeTrip } = await supabase
          .from("trips")
          .select(
            "id, driver_id, confirmed_driver_id, financial_outcome, payment_method",
          )
          .eq("id", tripId)
          .maybeSingle();
        const stamped = String(feeTrip?.financial_outcome ?? "").trim().toUpperCase();
        const outcome = isChargedFeeOutcome(stamped) ? stamped : "CANCELLED_WITH_FEE";
        const wallet = await postChargedFeeTenViaRfo({
          supabaseUrl,
          serviceRoleKey,
          tripId,
          driverId: resolveAssignedDriverId({
            driver_id: feeTrip?.driver_id,
            confirmed_driver_id: feeTrip?.confirmed_driver_id,
          }),
          outcome,
          feePence: Math.round(Number(result.captured_fee_pence) || 0),
          paymentMethod: feeTrip?.payment_method ?? null,
          disposition: result,
        });
        sweepRow.wallet_settlement_status = wallet.status;
        sweepRow.wallet_settlement_error = wallet.error ?? null;
        if (wallet.status !== "SUCCEEDED") {
          console.error("[sweep-revolut-stale-holds] WALLET_SETTLEMENT_FAILED_AFTER_FEE_CAPTURE", {
            trip_id: tripId,
            wallet,
            captured_fee_pence: result.captured_fee_pence,
          });
        }
      }

      results.push(sweepRow);

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

  // EXISTING CODE REPAIRED — heal completed trips where Revolut is COMPLETED but
  // Payment Session is still trip_created / missing captured_amount (manual capture).
  const { data: completedDrift } = await supabase
    .from("payment_sessions")
    .select(
      "id, trip_id, provider_order_id, authorised_amount_pence, captured_amount_pence, provider_state, status",
    )
    .eq("purpose", "RIDE_BOOKING")
    .eq("provider_state", "COMPLETED")
    .not("provider_order_id", "is", null)
    .not("trip_id", "is", null)
    .neq("status", "captured")
    .is("captured_amount_pence", null)
    .order("created_at", { ascending: true })
    .limit(limit);

  const healResults: Array<Record<string, unknown>> = [];
  for (const row of completedDrift ?? []) {
    const tripId = String(row.trip_id);
    const { data: trip } = await supabase
      .from("trips")
      .select("id, status, driver_id, driver_net_pence, tip_pence, tip_amount_pence, currency_code, currency, provider_order_id, capture_amount_pence")
      .eq("id", tripId)
      .maybeSingle();
    if (!trip || String(trip.status ?? "").toLowerCase() !== "completed") continue;

    if (dryRun) {
      healResults.push({ trip_id: tripId, dry_run: true, action: "would_heal_completed_capture" });
      continue;
    }

    try {
      const { secretKey, environment } = getRevolutMerchantConfig();
      const order = await retrieveRevolutOrder(environment, secretKey, String(row.provider_order_id));
      const state = String(order.state ?? "").toUpperCase();
      if (state !== "COMPLETED") {
        healResults.push({ trip_id: tripId, skipped: true, provider_state: state });
        continue;
      }
      const amountMinor = Math.round(Number(
        (order as { amount?: number }).amount
          ?? row.authorised_amount_pence
          ?? 0,
      ));
      const nowIso = new Date().toISOString();
      await supabase.from("payment_sessions").update({
        status: "captured",
        provider_state: "COMPLETED",
        captured_amount_pence: amountMinor > 0 ? amountMinor : null,
        captured_at: nowIso,
        provider_state_verified_at: nowIso,
        provider_state_verified_by: "sweep_completed_heal",
        updated_at: nowIso,
      }).eq("id", row.id);
      await supabase.from("trips").update({
        payment_status: "captured",
        capture_amount_pence: amountMinor > 0 ? amountMinor : trip.capture_amount_pence,
        provider_charge_id: row.provider_order_id,
        updated_at: nowIso,
      }).eq("id", tripId);
      if (trip.driver_id) {
        await applyCanonicalSettlementAfterCapture({
          supabase,
          tripId,
          trip: trip as Record<string, unknown>,
          captureAmountPence: amountMinor,
          tipPence: Math.max(0, Math.round(Number(trip.tip_pence ?? trip.tip_amount_pence ?? 0))),
          mode: "recovery",
        });
      }
      healResults.push({ trip_id: tripId, outcome: "HEALED_COMPLETED_CAPTURE", amount_pence: amountMinor });
    } catch (e) {
      healResults.push({
        trip_id: tripId,
        outcome: "HEAL_FAILED",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // Captured locally but provider_state still AUTHORISED — 010 retry leftover.
  // Snapshot only. Never void or recapture.
  const { data: capturedAuthorisedDrift } = await supabase
    .from("payment_sessions")
    .select(
      "id, trip_id, provider_state, status, captured_amount_pence",
    )
    .eq("purpose", "RIDE_BOOKING")
    .in("provider_state", ["AUTHORISED", "AUTHORIZED"])
    .eq("status", "captured")
    .gt("captured_amount_pence", 0)
    .not("trip_id", "is", null)
    .order("created_at", { ascending: true })
    .limit(limit);

  for (const row of capturedAuthorisedDrift ?? []) {
    const tripId = String(row.trip_id);
    const { data: trip } = await supabase
      .from("trips")
      .select("id, status, payment_status")
      .eq("id", tripId)
      .maybeSingle();
    if (!trip || String(trip.status ?? "").toLowerCase() !== "completed") continue;
    if (String(trip.payment_status ?? "").toLowerCase() !== "captured") continue;
    if (dryRun) {
      healResults.push({
        trip_id: tripId,
        dry_run: true,
        action: "would_heal_captured_authorised_snapshot",
      });
      continue;
    }
    const nowIso = new Date().toISOString();
    const { error: snapErr } = await supabase.from("payment_sessions").update({
      provider_state: "COMPLETED",
      provider_state_verified_at: nowIso,
      provider_state_verified_by: "sweep_captured_authorised_snapshot",
      updated_at: nowIso,
    }).eq("id", row.id);
    healResults.push({
      trip_id: tripId,
      action: "heal_captured_authorised_snapshot",
      ok: !snapErr,
      error: snapErr?.message ?? null,
    });
  }

  // Completed + AUTHORISED + uncaptured — MK-260815-010 class.
  // Dispose excludes completed (must not void a live fare hold). Retry finalize.
  const { data: completedAuthorised } = await supabase
    .from("payment_sessions")
    .select(
      "id, trip_id, provider_order_id, captured_amount_pence, provider_state, status",
    )
    .eq("purpose", "RIDE_BOOKING")
    .in("provider_state", ["AUTHORISED", "AUTHORIZED"])
    .not("provider_order_id", "is", null)
    .not("trip_id", "is", null)
    .is("captured_amount_pence", null)
    .order("created_at", { ascending: true })
    .limit(limit);

  const retryResults: Array<Record<string, unknown>> = [];
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  for (const row of completedAuthorised ?? []) {
    const tripId = String(row.trip_id);
    const { data: trip } = await supabase
      .from("trips")
      .select("id, status, payment_status, completed_at")
      .eq("id", tripId)
      .maybeSingle();
    if (!trip || String(trip.status ?? "").toLowerCase() !== "completed") continue;
    const pay = String(trip.payment_status ?? "").toLowerCase();
    if (!COMPLETED_CAPTURE_RETRY_PAYMENT_STATUSES.has(pay)) continue;
    const completedAt = trip.completed_at ? Date.parse(String(trip.completed_at)) : NaN;
    if (!Number.isFinite(completedAt) || (nowMs - completedAt) < COMPLETED_AUTHORISED_RETRY_GRACE_MS) {
      retryResults.push({
        trip_id: tripId,
        skipped: true,
        reason: "completed_too_recent",
      });
      continue;
    }
    if (dryRun) {
      retryResults.push({
        trip_id: tripId,
        dry_run: true,
        action: "would_retry_completed_authorised_capture",
        payment_status: trip.payment_status,
      });
      continue;
    }
    const rec = await invokeFinalizeTripCapture({
      supabaseUrl,
      serviceRoleKey,
      tripId,
      tipPence: 0,
      source: "sweep-revolut-stale-holds:completed_authorised_retry",
    });
    retryResults.push({
      trip_id: tripId,
      action: "retry_completed_authorised_capture",
      ok: rec.ok,
      error: rec.error ?? null,
      status: rec.body?.status ?? null,
      attempts: rec.attempts ?? null,
    });
  }

  // Trip-less AUTHORISED holds: create-trip never started (or failed before)
  // insert). The trip-scoped query above excludes these — they stay on the
  // customer's card until this path cancels the Revolut order.
  const { data: triplessSessions } = await supabase
    .from("payment_sessions")
    .select(
      "id, trip_id, provider_order_id, client_action_id, authorised_amount_pence, provider_state, status, created_at, authorised_at, released_at, captured_at, hold_release_state, captured_amount_pence",
    )
    .in("provider_state", ["AUTHORISED", "AUTHORIZED"])
    .in("status", ["payment_authorised", "pending_payment", "payment_orphaned"])
    .is("trip_id", null)
    .not("provider_order_id", "is", null)
    .order("created_at", { ascending: true })
    .limit(limit);

  // Local released / cancelled while provider_state still looks open — retrieve +
  // reconcile or retry release. Sweep previously skipped these via sessionAlreadyTerminal.
  const { data: falseReleaseDrift } = await supabase
    .from("payment_sessions")
    .select(
      "id, trip_id, provider_order_id, client_action_id, authorised_amount_pence, provider_state, status, created_at, authorised_at, released_at, captured_at, hold_release_state, captured_amount_pence",
    )
    .eq("purpose", "RIDE_BOOKING")
    .in("provider_state", ["AUTHORISED", "AUTHORIZED", "PAYMENT_AUTHENTICATED", "PENDING", "PROCESSING"])
    .eq("hold_release_state", "released")
    .is("captured_at", null)
    .not("provider_order_id", "is", null)
    .order("created_at", { ascending: true })
    .limit(limit);

  const { data: localOnlyStale } = await supabase
    .from("payment_sessions")
    .select("id, provider_state, status, created_at, authorised_at")
    .in("provider_state", ["AUTHORISED", "AUTHORIZED"])
    .in("status", ["payment_authorised", "pending_payment", "payment_orphaned"])
    .is("trip_id", null)
    .is("provider_order_id", null)
    .order("created_at", { ascending: true })
    .limit(limit);

  const orphanResults: Array<Record<string, unknown>> = [];
  for (const row of localOnlyStale ?? []) {
    const ageMs = sessionAgeMs(row as Record<string, unknown>);
    if (ageMs < TRIPLESS_AUTHORISED_HOLD_SWEEP_MIN_AGE_MS) continue;
    if (dryRun) {
      orphanResults.push({
        payment_session_id: row.id,
        dry_run: true,
        action: "would_close_local_only_stale",
        age_ms: ageMs,
      });
      continue;
    }
    const now = new Date().toISOString();
    const { error: flipErr } = await supabase.from("payment_sessions").update({
      provider_state: "CANCELLED",
      provider_state_verified_at: now,
      provider_state_verified_by: "sweep_local_only_stale",
      updated_at: now,
    }).eq("id", row.id);
    if (flipErr) {
      orphanResults.push({ payment_session_id: row.id, outcome: "LOCAL_FLIP_FAILED", message: flipErr.message });
      continue;
    }
    const { error: closeErr } = await supabase.from("payment_sessions").update({
      status: "cancelled",
      hold_release_state: "released",
      released_at: now,
      hold_terminal_reason: "sweep_local_only_no_provider_order",
      failure_reason: "missing_provider_order_id",
      updated_at: now,
    }).eq("id", row.id);
    orphanResults.push({
      payment_session_id: row.id,
      action: "closed_local_only_stale",
      ok: !closeErr,
      error: closeErr?.message ?? null,
      age_ms: ageMs,
    });
  }

  for (const row of triplessSessions ?? []) {
    const ageMs = sessionAgeMs(row as Record<string, unknown>);
    if (ageMs < TRIPLESS_AUTHORISED_HOLD_SWEEP_MIN_AGE_MS) {
      orphanResults.push({
        payment_session_id: row.id,
        skipped: true,
        reason: "authorised_too_recent",
        age_ms: ageMs,
      });
      continue;
    }
    if (dryRun) {
      orphanResults.push({
        payment_session_id: row.id,
        dry_run: true,
        action: "would_release_tripless_hold",
        auth_pence: row.authorised_amount_pence,
        order_mask: String(row.provider_order_id).slice(0, 8) + "…",
        age_ms: ageMs,
      });
      continue;
    }
    try {
      const release = await releaseHoldForPaymentSession(supabase, {
        providerOrderId: String(row.provider_order_id),
        clientActionId: (row.client_action_id as string | null) ?? null,
        terminalReason: "sweep_tripless_authorised_hold",
        source: "sweep-revolut-stale-holds",
        idempotencyKey: `sweep_tripless_${row.id}`,
        session: row as Record<string, unknown>,
      });
      orphanResults.push({
        payment_session_id: row.id,
        ...release,
        age_ms: ageMs,
      });
    } catch (e) {
      orphanResults.push({
        payment_session_id: row.id,
        ok: false,
        outcome: "PROVIDER_FAILED",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const falseReleaseResults: Array<Record<string, unknown>> = [];
  for (const row of falseReleaseDrift ?? []) {
    if (dryRun) {
      // Read-only Merchant GET — classify only; never cancel/release/write.
      try {
        const { secretKey, environment } = getRevolutMerchantConfig();
        const order = await retrieveRevolutOrder(
          environment,
          secretKey,
          String(row.provider_order_id),
        );
        const providerState = String(order.state ?? "").toUpperCase();
        const completed = Math.max(0, Number((order as { completed_amount?: number }).completed_amount ?? 0));
        let classification = "UNKNOWN_PROVIDER_STATE";
        let providerReleaseCandidate = false;
        if (completed > 0 || providerState === "COMPLETED" || providerState === "CAPTURED") {
          classification = "PROVIDER_CAPTURED_EXCLUDE_FROM_HOLD_RELEASE";
        } else if (
          providerState === "CANCELLED" ||
          providerState === "CANCELED" ||
          providerState === "FAILED"
        ) {
          classification = "PROVIDER_ALREADY_CANCELLED_LOCAL_RECONCILIATION_REQUIRED";
        } else if (
          providerState === "AUTHORISED" ||
          providerState === "AUTHORIZED" ||
          providerState === "PENDING" ||
          providerState === "PROCESSING"
        ) {
          classification = "ACTIVE_PROVIDER_HOLD_RELEASE_CANDIDATE";
          providerReleaseCandidate = true;
        }
        falseReleaseResults.push({
          payment_session_id: row.id,
          dry_run: true,
          action: "classify_false_local_release",
          classification,
          provider_release_candidate: providerReleaseCandidate,
          local_provider_state: row.provider_state,
          merchant_provider_state: providerState,
          completed_amount: completed,
          auth_pence: row.authorised_amount_pence,
          order_mask: String(row.provider_order_id).slice(0, 8) + "…",
          provider_release_calls: 0,
          database_writes: 0,
        });
      } catch (e) {
        falseReleaseResults.push({
          payment_session_id: row.id,
          dry_run: true,
          ok: false,
          classification: "PROVIDER_GET_FAILED",
          outcome: "PROVIDER_FAILED",
          message: e instanceof Error ? e.message : String(e),
          provider_release_calls: 0,
          database_writes: 0,
        });
      }
      continue;
    }
    try {
      const release = await releaseHoldForPaymentSession(supabase, {
        providerOrderId: String(row.provider_order_id),
        clientActionId: (row.client_action_id as string | null) ?? null,
        terminalReason: "sweep_false_local_release_reconcile",
        source: "sweep-revolut-stale-holds",
        idempotencyKey: `sweep_false_release_${row.id}`,
        session: row as Record<string, unknown>,
      });
      falseReleaseResults.push({
        payment_session_id: row.id,
        ...release,
        // Live reconcile path must not POST cancel when provider already cancelled
        // (releaseHoldForPaymentSession → RECONCILE_LOCAL_ONLY).
        classification: release.reconciled
          ? "PROVIDER_ALREADY_CANCELLED_LOCAL_RECONCILED"
          : (release.status ?? null),
      });
    } catch (e) {
      falseReleaseResults.push({
        payment_session_id: row.id,
        ok: false,
        outcome: "PROVIDER_FAILED",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const itemOutcomes = summarizeHoldSweepItemOutcomes([
    ...results.map((r) => ({
      ok: r.ok as boolean | undefined,
      outcome: String(r.outcome ?? r.status ?? ""),
      status: String(r.status ?? ""),
    })),
    ...orphanResults.map((r) => ({
      ok: r.ok as boolean | undefined,
      outcome: String(r.outcome ?? r.status ?? ""),
      status: String(r.status ?? ""),
    })),
    ...falseReleaseResults.map((r) => ({
      ok: r.ok as boolean | undefined,
      outcome: String(r.outcome ?? r.status ?? ""),
      status: String(r.status ?? ""),
    })),
    ...healResults.map((r) => ({
      ok: r.ok as boolean | undefined,
      outcome: String(r.outcome ?? ""),
      status: String(r.action ?? ""),
    })),
    ...retryResults.map((r) => ({
      ok: r.ok as boolean | undefined,
      outcome: String(r.outcome ?? ""),
      status: String(r.action ?? ""),
    })),
  ]);

  return new Response(JSON.stringify({
    success: itemOutcomes.overall_ok,
    http_ok: true,
    dry_run: dryRun,
    scanned_sessions: sessionRows.length,
    eligible: candidates.length,
    results,
    tripless_holds: orphanResults,
    false_local_release_reconcile: falseReleaseResults,
    completed_capture_heals: healResults,
    completed_authorised_retries: retryResults,
    item_outcomes: itemOutcomes,
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
