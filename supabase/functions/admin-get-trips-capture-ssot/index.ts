import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { z } from "https://esm.sh/zod@3.23.8";
import { corsHeaders, jsonResponse, requireAdmin } from "../_shared/adminPaymentGate.ts";
import {
  mapTripsToCaptureSsotRows,
  TRIP_CAPTURE_SSOT_SELECT,
  type TripCaptureSsotRow,
} from "../_shared/tripsCaptureSsotBatch.ts";
import type { TripAuditSourceRow } from "../_shared/financeSettlementSummary.ts";

const InputSchema = z.object({
  trip_ids: z.array(z.string().uuid()).max(500),
});

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const gate = await requireAdmin(req);
    if (!gate.ok) return gate.response;

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ error: "Invalid JSON body" }, 400);
    }

    const parsed = InputSchema.safeParse(body);
    if (!parsed.success) {
      return jsonResponse({ error: "Invalid input", details: parsed.error.flatten() }, 400);
    }

    const tripIds = [...new Set(parsed.data.trip_ids)];
    if (tripIds.length === 0) {
      return jsonResponse({ success: true, trips: [] as TripCaptureSsotRow[] });
    }

    const { data: trips, error: tripsErr } = await gate.supabase
      .from("trips")
      .select(TRIP_CAPTURE_SSOT_SELECT)
      .in("id", tripIds);

    if (tripsErr) throw tripsErr;

    const [paymentsRes, payoutItemsRes, ledgerRes] = await Promise.all([
      gate.supabase
        .from("payments")
        .select("trip_id, captured_amount_pence, amount_pence, status, provider_status, stripe_payment_intent_id, provider_available_on, fee_type, metadata")
        .in("trip_id", tripIds),
      gate.supabase
        .from("payout_items")
        .select("trip_id, status, driver_amount_pence, amount_pence, batch_id")
        .in("trip_id", tripIds),
      gate.supabase
        .from("driver_wallet_ledger")
        .select("related_trip_id, type, amount_pence, stripe_payout_id, stripe_transfer_id")
        .in("related_trip_id", tripIds),
    ]);

    if (paymentsRes.error) throw paymentsRes.error;
    if (payoutItemsRes.error) throw payoutItemsRes.error;
    if (ledgerRes.error) throw ledgerRes.error;

    const trips_capture_ssot = mapTripsToCaptureSsotRows({
      trips: (trips ?? []) as TripAuditSourceRow[],
      payments: paymentsRes.data ?? [],
      payoutItems: payoutItemsRes.data ?? [],
      ledgerRows: (ledgerRes.data ?? []).map((row) => ({
        related_trip_id: row.related_trip_id ?? null,
        type: row.type,
        amount_pence: row.amount_pence,
        stripe_payout_id: row.stripe_payout_id ?? null,
        stripe_transfer_id: row.stripe_transfer_id ?? null,
      })),
    });

    return jsonResponse({
      success: true,
      ssot_source: "trip_financial_audit",
      trips: trips_capture_ssot,
    });
  } catch (e) {
    console.error("[admin-get-trips-capture-ssot]", e);
    return jsonResponse({ error: (e as Error).message }, 500);
  }
});
