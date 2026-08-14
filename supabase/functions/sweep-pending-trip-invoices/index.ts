/**
 * Retry pending customer trip invoices after tip-window / webhook misses.
 *
 * Replaces the invoice-retry portion of retired sweep-stale-payment-intents.
 * Does not mutate payment intents — only invokes the canonical invoice owner
 * (`maybeInvokeAutoTripInvoice` → `trip-invoice-process`).
 *
 * Body (optional): { dry_run?: boolean, limit?: number }
 */

import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  canAutoSendCustomerInvoice,
  isTipWindowClosedForInvoice,
  isTripCompletedForCustomerInvoice,
} from "../_shared/tripInvoiceEligibility.ts";
import {
  invokeTripInvoiceProcess,
  maybeInvokeAutoTripInvoice,
} from "../_shared/tripInvoiceTrigger.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const log = (step: string, details?: unknown) => {
  const d = details ? ` - ${JSON.stringify(details)}` : "";
  console.log(`[SWEEP-PENDING-TRIP-INVOICES] ${step}${d}`);
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false },
    });

    let body: Record<string, unknown> = {};
    try {
      body = await req.json();
    } catch {
      /* empty ok */
    }

    const dryRun = body.dry_run === true;
    const limit = Math.min(100, Math.max(1, Number(body.limit ?? 40)));

    const { data: candidates, error } = await supabase
      .from("trips")
      .select(
        "id, status, completed_at, payment_method, payment_status, payment_provider, provider_order_id, capture_amount_pence, invoice_email_sent, invoice_email_status, invoice_generated_at, invoice_pdf_url, tip_window_closed_at, tip_window_expires_at",
      )
      .eq("status", "completed")
      .eq("invoice_email_sent", false)
      .or(
        "invoice_email_status.is.null,invoice_email_status.eq.failed,invoice_email_status.eq.sending,invoice_email_status.eq.pending",
      )
      .not("completed_at", "is", null)
      .order("completed_at", { ascending: true })
      .limit(limit);

    if (error) throw new Error(error.message);

    // Never retry intentional skip — no valid customer email.
    const eligible = (candidates ?? []).filter((row) => {
      const status = String(row.invoice_email_status ?? "").toLowerCase();
      return status !== "skipped_no_valid_email";
    });

    log("Candidates", { queried: candidates?.length ?? 0, eligible: eligible.length, dryRun });

    const results: Array<Record<string, unknown>> = [];
    let invoked = 0;

    for (const trip of eligible) {
      const tripId = trip.id as string;
      const pdfReady = Boolean(trip.invoice_generated_at || trip.invoice_pdf_url);
      const autoGate = canAutoSendCustomerInvoice(trip);
      // PDF fallback when email auto is blocked but trip is terminal + tip closed.
      const pdfFallback =
        !pdfReady &&
        !autoGate.ok &&
        isTripCompletedForCustomerInvoice(trip) &&
        isTipWindowClosedForInvoice(trip) &&
        autoGate.reason !== "already_sent" &&
        autoGate.reason !== "trip_still_active";

      if (dryRun) {
        results.push({
          trip_id: tripId,
          action: autoGate.ok ? "would_auto" : pdfFallback ? "would_generate_only" : "would_skip",
          reason: autoGate.reason ?? null,
        });
        continue;
      }

      if (autoGate.ok) {
        await maybeInvokeAutoTripInvoice(
          supabase,
          supabaseUrl,
          serviceKey,
          tripId,
          "sweep-pending-trip-invoices",
        );
        invoked++;
        results.push({ trip_id: tripId, action: "auto" });
        continue;
      }

      if (pdfFallback) {
        await invokeTripInvoiceProcess(supabaseUrl, serviceKey, tripId, "generate_only");
        invoked++;
        results.push({
          trip_id: tripId,
          action: "generate_only",
          reason: autoGate.reason ?? "pdf_fallback",
        });
        continue;
      }

      results.push({ trip_id: tripId, action: "skipped", reason: autoGate.reason ?? "not_eligible" });
    }

    return new Response(
      JSON.stringify({
        success: true,
        scanned: candidates?.length ?? 0,
        eligible: eligible.length,
        invoked,
        dry_run: dryRun,
        results,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("ERROR", { message: msg });
    return new Response(JSON.stringify({ error: msg }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});
