/**
 * Server-side final fare capture after the post-trip tip window expires.
 *
 * Must run on a schedule (pg_cron) — never rely on the customer app countdown.
 * Invokes finalize-trip-and-capture (internal) fare-only for each eligible trip.
 * Live capture and the dry-run label both force tip 0. A stale claim is cleared
 * and never passed into capture. Only a customer Submit before expiry may add a tip.
 * An already-captured window is closed without a second POST. A leftover claim
 * is cleared unless that capture already settled the tip. Expiry never inserts
 * DRIVER_TIP_CREDIT and never writes financial reconciliation.
 *
 * Body (optional): { dry_run?: boolean, limit?: number }
 */

import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { assertCronOrServiceRoleAuth } from "../_shared/cronEdgeAuth.ts";
import { invokeFinalizeTripCapture } from "../_shared/invokeFinalizeTripCapture.ts";
import { maybeInvokeAutoTripInvoice } from "../_shared/tripInvoiceTrigger.ts";
import {
  isTripPaymentFinalised,
  needsServerTipWindowFareCapture,
  expiryFareOnlyTipPence,
  storedCaptureAllowsTipWindowClose,
  tipWindowCloseAllowedAfterFinalize,
  visibleTipAfterExpiredWindowClose,
} from "../../../shared/tripPaymentFinalised.ts";
import { computeCaptureAmount } from "../_shared/tripFareSSOT.ts";
import { TIP_WINDOW_STATUS } from "../../../shared/tipWindowConstants.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-onecab-cron-secret",
};

const log = (step: string, details?: unknown) => {
  const d = details ? ` - ${JSON.stringify(details)}` : "";
  console.log(`[CAPTURE-EXPIRED-TIP-WINDOWS] ${step}${d}`);
};

const UNCAPPED_PAYMENT_STATUSES = [
  "preauth_created",
  "preauth_authorized",
  "preauth_authorised",
  "authorized",
  "authorised",
  "preauth_updated",
  "capture_requested",
  "capture_failed",
  // Preauth may never have been stamped authorised. Still fare-capture.
  "pending",
  // Shortfall must stay retryable. Closing the window on a zero capture
  // strands the fare (invokeFinalize treats shortfall as business-ok).
  "payment_shortfall",
  "recovery_required",
];

/** Nothing left to capture. Close the window so the invoice is not stuck. */
const SEAL_WITHOUT_CAPTURE_STATUSES = ["canceled", "cancelled", "released"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    let body: Record<string, unknown> = {};
    try {
      body = await req.json();
    } catch {
      /* empty body ok */
    }

    const auth = await assertCronOrServiceRoleAuth(req, body);
    if (!auth.ok) return auth.response;

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } },
    );

    const dryRun = body.dry_run === true;
    const limit = Math.min(100, Math.max(1, Number(body.limit ?? 50)));
    const nowIso = new Date().toISOString();

    log("Sweep started", { dryRun, limit, nowIso, auth: auth.source });

    const { data: candidates, error: queryErr } = await supabase
      .from("trips")
      .select(
        "id, status, payment_method, payment_status, payment_provider, financial_model, payment_intent_id, provider_order_id, payment_session_id, tip_window_expires_at, tip_window_closed_at, tip_amount_pence, tip_pence, completed_at",
      )
      .eq("status", "completed")
      .or("payment_intent_id.not.is.null,provider_order_id.not.is.null,payment_session_id.not.is.null")
      .lt("tip_window_expires_at", nowIso)
      .is("tip_window_closed_at", null)
      .in("payment_status", UNCAPPED_PAYMENT_STATUSES)
      .order("tip_window_expires_at", { ascending: true })
      .limit(limit);

    if (queryErr) throw new Error(`Trip query failed: ${queryErr.message}`);

    // Session-only stamps have no trip order id. Copy the session order so
    // finalize can capture; do not close a window we still cannot capture.
    for (const row of candidates ?? []) {
      if (String(row.provider_order_id ?? "").trim() || String(row.payment_intent_id ?? "").trim()) {
        continue;
      }
      const sessionId = String(row.payment_session_id ?? "").trim();
      if (!sessionId) continue;
      const { data: session, error: sessionErr } = await supabase
        .from("payment_sessions")
        .select("provider_order_id")
        .eq("id", sessionId)
        .maybeSingle();
      if (sessionErr) {
        log("Session order lookup failed", { trip_id: row.id, error: sessionErr.message });
        continue;
      }
      const sessionOrderId = String(session?.provider_order_id ?? "").trim();
      if (!sessionOrderId) continue;
      if (!dryRun) {
        const { error: orderErr } = await supabase.from("trips").update({
          provider_order_id: sessionOrderId,
          updated_at: nowIso,
        }).eq("id", row.id).is("provider_order_id", null);
        if (orderErr) {
          log("Session order copy failed", { trip_id: row.id, error: orderErr.message });
          continue;
        }
      }
      row.provider_order_id = sessionOrderId;
    }

    const eligible = (candidates ?? []).filter((row) => {
      if (!needsServerTipWindowFareCapture(row, Date.now())) return false;
      // Revolut-only capture path — skip any non-Revolut trip.
      if (String(row.payment_provider ?? "").toLowerCase() !== "revolut") return false;
      if (
        String(row.financial_model ?? "").toUpperCase() ===
          "DRIVER_COLLECTED_COMMISSION_WALLET"
      ) {
        return false;
      }
      return true;
    });

    // Hygiene: payment already finalised but tip window never closed (e.g. close failed after capture).
    const { data: alreadyFinalisedOpen, error: finalisedErr } = await supabase
      .from("trips")
      .select(
        "id, payment_status, payment_method, payment_provider, financial_model, payment_intent_id, provider_order_id, capture_amount_pence, final_fare_pence, final_customer_fare_pence, gross_fare_pence, locked_base_fare_pence, tip_pence, tip_amount_pence, airport_charge_pence, pickup_waiting_charge_pence, stop_waiting_charge_pence, total_waiting_charge_pence, discount_pence, offer_discount_pence, tip_window_expires_at, tip_window_closed_at",
      )
      .eq("status", "completed")
      .lt("tip_window_expires_at", nowIso)
      .is("tip_window_closed_at", null)
      .in("payment_status", ["captured", "paid", "collected_cash"])
      .order("tip_window_expires_at", { ascending: true })
      .limit(limit);

    if (finalisedErr) {
      log("Finalised-open query failed (non-blocking)", { error: finalisedErr.message });
    }

    // Canceled / released holds must not be captured again, and must not leave
    // the window open so the invoice waits forever.
    const { data: sealWithoutCapture, error: sealErr } = await supabase
      .from("trips")
      .select("id, payment_status")
      .eq("status", "completed")
      .lt("tip_window_expires_at", nowIso)
      .is("tip_window_closed_at", null)
      .in("payment_status", SEAL_WITHOUT_CAPTURE_STATUSES)
      .order("tip_window_expires_at", { ascending: true })
      .limit(limit);
    if (sealErr) {
      log("Seal-without-capture query failed (non-blocking)", { error: sealErr.message });
    }

    const closeOnly = (alreadyFinalisedOpen ?? []).filter((row) =>
      isTripPaymentFinalised(row.payment_status as string | null)
      && storedCaptureAllowsTipWindowClose({
        paymentMethod: row.payment_method as string | null,
        paymentStatus: row.payment_status as string | null,
        captureAmountPence: row.capture_amount_pence as number | null,
      })
    );
    // Status "captured" with no amount is not a capture. Reconcile via finalize
    // instead of sealing the window and invoicing an unpaid fare.
    const unprovenCaptured = (alreadyFinalisedOpen ?? []).filter((row) => {
      if (!isTripPaymentFinalised(row.payment_status as string | null)) return false;
      if (storedCaptureAllowsTipWindowClose({
        paymentMethod: row.payment_method as string | null,
        paymentStatus: row.payment_status as string | null,
        captureAmountPence: row.capture_amount_pence as number | null,
      })) return false;
      if (String(row.payment_provider ?? "").toLowerCase() !== "revolut") return false;
      if (
        String(row.financial_model ?? "").toUpperCase() ===
          "DRIVER_COLLECTED_COMMISSION_WALLET"
      ) return false;
      return Boolean(row.provider_order_id || row.payment_intent_id);
    });

    const driverCollectedSkip = (candidates ?? []).filter((row) =>
      String(row.financial_model ?? "").toUpperCase() === "DRIVER_COLLECTED_COMMISSION_WALLET"
    );

    log("Candidates", {
      queried: candidates?.length ?? 0,
      eligible: eligible.length,
      close_only: closeOnly.length,
      driver_collected_skip: driverCollectedSkip.length,
    });

    const results: Array<Record<string, unknown>> = [];
    let capturedCount = 0;
    let failedCount = 0;
    let closedOnlyCount = 0;

    for (const trip of sealWithoutCapture ?? []) {
      const tripId = trip.id as string;
      if (dryRun) {
        results.push({ trip_id: tripId, action: "would_close_nothing_to_capture", payment_status: trip.payment_status });
        continue;
      }
      const { error: closeErr } = await supabase.from("trips").update({
        tip_amount_pence: 0,
        tip_pence: 0,
        tip_window_closed_at: nowIso,
        tip_window_status: TIP_WINDOW_STATUS.CLOSED,
        updated_at: nowIso,
      }).eq("id", tripId).is("tip_window_closed_at", null);
      if (closeErr) {
        failedCount++;
        results.push({ trip_id: tripId, action: "close_failed", error: closeErr.message });
        continue;
      }
      closedOnlyCount++;
      results.push({ trip_id: tripId, action: "closed_nothing_to_capture" });
    }

    for (const trip of driverCollectedSkip) {
      const tripId = trip.id as string;
      if (dryRun) {
        results.push({ trip_id: tripId, action: "would_close_driver_collected" });
        continue;
      }
      // Platform capture is forbidden. Close the window and do not keep a platform tip.
      const { error: closeErr } = await supabase.from("trips").update({
        tip_amount_pence: 0,
        tip_pence: 0,
        tip_window_closed_at: nowIso,
        tip_window_status: TIP_WINDOW_STATUS.CLOSED,
        updated_at: nowIso,
      }).eq("id", tripId).is("tip_window_closed_at", null);
      if (closeErr) {
        failedCount++;
        results.push({ trip_id: tripId, action: "close_failed", error: closeErr.message });
        continue;
      }
      results.push({ trip_id: tripId, action: "closed_driver_collected" });
    }

    for (const trip of [...eligible, ...unprovenCaptured]) {
      const tripId = trip.id as string;

      if (dryRun) {
        results.push({
          trip_id: tripId,
          action: "would_capture_fare_only",
          tip_pence: expiryFareOnlyTipPence(trip.tip_amount_pence ?? trip.tip_pence),
        });
        continue;
      }

      try {
        // Drop a leftover claim before capture so finalize cannot read it as a tip.
        const { error: clearClaimErr } = await supabase.from("trips").update({
          tip_amount_pence: 0,
          tip_pence: 0,
          updated_at: nowIso,
        }).eq("id", tripId).is("tip_window_closed_at", null);
        if (clearClaimErr) {
          failedCount++;
          results.push({
            trip_id: tripId,
            action: "clear_claim_failed",
            error: clearClaimErr.message,
          });
          continue;
        }

        const tipPence = expiryFareOnlyTipPence(trip.tip_amount_pence ?? trip.tip_pence);
        const rec = await invokeFinalizeTripCapture({
          supabaseUrl: Deno.env.get("SUPABASE_URL")!,
          serviceRoleKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
          tripId,
          tipPence,
          source: "capture_expired_tip_windows",
        });

        const recJson = rec.body ?? {};
        const ok = rec.ok;
        log("[PAYMENT_AUDIT] server_tip_window_capture", {
          trip_id: tripId,
          http_status: rec.httpStatus,
          attempts: rec.attempts,
          deferred: recJson.deferred ?? false,
          already_captured: recJson.already_captured ?? false,
          ok,
        });

        const captureConfirmed = tipWindowCloseAllowedAfterFinalize(recJson);
        results.push({
          trip_id: tripId,
          action: captureConfirmed
            ? (recJson.already_captured ? "already_captured" : "captured")
            : (recJson.deferred ? "deferred" : "capture_not_confirmed"),
          http_status: rec.httpStatus,
          attempts: rec.attempts,
          body: recJson,
        });

        if (captureConfirmed) {
          capturedCount++;
          const collected = expiryFareOnlyTipPence(recJson.tip_collected_pence);
          await supabase.from("trips").update({
            tip_amount_pence: collected,
            tip_pence: collected,
            tip_window_closed_at: nowIso,
            tip_window_status: TIP_WINDOW_STATUS.CLOSED,
            updated_at: nowIso,
          }).eq("id", tripId).is("tip_window_closed_at", null);
          // Tip window now closed + capture attempted — canonical invoice owner.
          try {
            await maybeInvokeAutoTripInvoice(
              supabase,
              Deno.env.get("SUPABASE_URL")!,
              Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
              tripId,
              "capture-expired-tip-windows",
            );
          } catch (invoiceErr) {
            log("Invoice invoke failed (non-blocking)", {
              trip_id: tripId,
              error: invoiceErr instanceof Error ? invoiceErr.message : String(invoiceErr),
            });
          }
        } else failedCount++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log("Capture invoke failed", { trip_id: tripId, error: msg });
        results.push({ trip_id: tripId, action: "error", error: msg });
        failedCount++;
      }
    }

    const closeOnlyIds = closeOnly.map((trip) => trip.id as string);
    const settledTipByTrip = new Map<string, number>();
    let settledTipReadFailed = false;
    if (closeOnlyIds.length > 0) {
      const { data: tipCredits, error: tipCreditErr } = await supabase
        .from("driver_wallet_ledger")
        .select("related_trip_id, amount_pence")
        .in("related_trip_id", closeOnlyIds)
        .eq("type", "DRIVER_TIP_CREDIT");
      if (tipCreditErr) {
        settledTipReadFailed = true;
        log("Tip settlement read failed", { error: tipCreditErr.message });
      } else {
        for (const row of tipCredits ?? []) {
          const id = String(row.related_trip_id ?? "");
          if (!id) continue;
          const amount = Math.max(0, Math.round(Number(row.amount_pence) || 0));
          settledTipByTrip.set(id, (settledTipByTrip.get(id) ?? 0) + amount);
        }
      }
    }

    for (const trip of closeOnly) {
      const tripId = trip.id as string;
      if (settledTipReadFailed) {
        failedCount++;
        results.push({ trip_id: tripId, action: "tip_settlement_read_failed" });
        continue;
      }
      const requestedTip = Math.max(
        0,
        Math.round(Number(trip.tip_amount_pence ?? trip.tip_pence ?? 0) || 0),
      );
      const farePence = computeCaptureAmount(trip as never, "completed", 0).capture_amount_pence;
      const visibleTip = visibleTipAfterExpiredWindowClose({
        requestedTipPence: requestedTip,
        priorSettledTipPence: settledTipByTrip.get(tripId) ?? 0,
        captureAmountPence: Number(trip.capture_amount_pence ?? 0) || 0,
        farePence,
      });
      const clearedStaleTip = requestedTip > 0 && visibleTip === 0;
      if (dryRun) {
        results.push({
          trip_id: tripId,
          action: clearedStaleTip ? "would_clear_stale_tip" : "would_close_already_finalised",
          tip_pence: visibleTip,
        });
        continue;
      }
      // Already captured: close only. Never POST a second capture or invent a tip credit.
      const { error: closeErr } = await supabase.from("trips").update({
        tip_amount_pence: visibleTip,
        tip_pence: visibleTip,
        tip_window_closed_at: nowIso,
        tip_window_status: TIP_WINDOW_STATUS.CLOSED,
        updated_at: nowIso,
      }).eq("id", tripId).is("tip_window_closed_at", null);
      if (closeErr) {
        failedCount++;
        results.push({ trip_id: tripId, action: "close_failed", error: closeErr.message });
        continue;
      }
      closedOnlyCount++;
      results.push({
        trip_id: tripId,
        action: clearedStaleTip ? "cleared_stale_tip" : "closed_already_finalised",
        tip_pence: visibleTip,
      });
      try {
        await maybeInvokeAutoTripInvoice(
          supabase,
          Deno.env.get("SUPABASE_URL")!,
          Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
          tripId,
          "capture-expired-tip-windows",
        );
      } catch (invoiceErr) {
        log("Invoice invoke failed (non-blocking)", {
          trip_id: tripId,
          error: invoiceErr instanceof Error ? invoiceErr.message : String(invoiceErr),
        });
      }
    }

    log("Sweep finished", {
      eligible: eligible.length,
      captured: capturedCount,
      closed_only: closedOnlyCount,
      failed: failedCount,
    });

    return new Response(
      JSON.stringify({
        success: true,
        scanned: candidates?.length ?? 0,
        eligible: eligible.length,
        captured: capturedCount,
        closed_only: closedOnlyCount,
        failed: failedCount,
        dry_run: dryRun,
        results,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 },
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log("ERROR", { message: msg });
    return new Response(JSON.stringify({ error: msg }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});
