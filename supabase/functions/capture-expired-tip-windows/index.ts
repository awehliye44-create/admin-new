/**
 * Server-side final fare capture after the post-trip tip window expires.
 *
 * Must run on a schedule (pg_cron) — never rely on the customer app countdown.
 * Invokes finalize-trip-and-capture (internal) fare-only for each eligible trip.
 *
 * Body (optional): { dry_run?: boolean, limit?: number }
 */

import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { invokeFinalizeTripCapture } from "../_shared/invokeFinalizeTripCapture.ts";
import { maybeInvokeAutoTripInvoice } from "../_shared/tripInvoiceTrigger.ts";
import { needsServerTipWindowFareCapture } from "../../../shared/tripPaymentFinalised.ts";
import {
  isStripeRuntimeDisabled,
  emitStripeRetirementTelemetry,
  STRIPE_RUNTIME_BLOCKED,
} from "../_shared/stripeRuntimeDisabled.ts";
import { looksLikeStripePaymentIntentId } from "../_shared/stripeRetirementGuard.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const log = (step: string, details?: unknown) => {
  const d = details ? ` - ${JSON.stringify(details)}` : "";
  console.log(`[CAPTURE-EXPIRED-TIP-WINDOWS] ${step}${d}`);
};

const UNCAPPED_PAYMENT_STATUSES = [
  "preauth_created",
  "preauth_authorized",
  "authorized",
  "preauth_updated",
  "capture_requested",
  "capture_failed",
];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } },
    );

    let body: Record<string, unknown> = {};
    try {
      body = await req.json();
    } catch {
      /* empty body ok */
    }

    const dryRun = body.dry_run === true;
    const limit = Math.min(100, Math.max(1, Number(body.limit ?? 50)));
    const nowIso = new Date().toISOString();

    log("Sweep started", { dryRun, limit, nowIso });

    const { data: candidates, error: queryErr } = await supabase
      .from("trips")
      .select(
        "id, status, payment_method, payment_status, payment_provider, payment_intent_id, provider_order_id, tip_window_expires_at, tip_window_closed_at, completed_at",
      )
      .eq("status", "completed")
      .or("payment_intent_id.not.is.null,provider_order_id.not.is.null")
      .lt("tip_window_expires_at", nowIso)
      .in("payment_status", UNCAPPED_PAYMENT_STATUSES)
      .order("tip_window_expires_at", { ascending: true })
      .limit(limit);

    if (queryErr) throw new Error(`Trip query failed: ${queryErr.message}`);

    const stripeOff = isStripeRuntimeDisabled();
    const eligible = (candidates ?? []).filter((row) => {
      if (!needsServerTipWindowFareCapture(row, Date.now())) return false;
      const providerPaymentId = String(
        row.payment_intent_id ?? row.provider_order_id ?? "",
      ).trim() || null;
      const isStripeTrip =
        String(row.payment_provider ?? "").toLowerCase() === "stripe"
        || looksLikeStripePaymentIntentId(providerPaymentId);
      if (stripeOff && isStripeTrip) {
        emitStripeRetirementTelemetry({
          event: STRIPE_RUNTIME_BLOCKED,
          function: "capture-expired-tip-windows",
          operation: "skip_stripe_trip",
          trip_id: row.id as string,
        });
        return false;
      }
      return true;
    });

    log("Candidates", { queried: candidates?.length ?? 0, eligible: eligible.length });

    const results: Array<Record<string, unknown>> = [];
    let capturedCount = 0;
    let failedCount = 0;

    for (const trip of eligible) {
      const tripId = trip.id as string;

      if (dryRun) {
        results.push({ trip_id: tripId, action: "would_capture_fare_only" });
        continue;
      }

      try {
        const rec = await invokeFinalizeTripCapture({
          supabaseUrl: Deno.env.get("SUPABASE_URL")!,
          serviceRoleKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
          tripId,
          tipPence: 0,
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

        results.push({
          trip_id: tripId,
          action: ok
            ? (recJson.already_captured ? "already_captured" : "captured")
            : (recJson.deferred ? "deferred" : "capture_failed"),
          http_status: rec.httpStatus,
          attempts: rec.attempts,
          body: recJson,
        });

        if (ok) {
          capturedCount++;
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

    log("Sweep finished", { eligible: eligible.length, captured: capturedCount, failed: failedCount });

    return new Response(
      JSON.stringify({
        success: true,
        scanned: candidates?.length ?? 0,
        eligible: eligible.length,
        captured: capturedCount,
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
