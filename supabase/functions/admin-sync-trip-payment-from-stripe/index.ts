// Admin: read-only sync from Stripe for legacy trips (audit backfill — no new Stripe bookings).
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { z } from "https://esm.sh/zod@3.23.8";
import { corsHeaders, jsonResponse, requireAdmin } from "../_shared/adminPaymentGate.ts";
import { adminLegacyStripeSyncFromProvider } from "../_shared/adminLegacyStripeTripPayment.ts";
import { resolveTripPaymentProvider } from "../_shared/tripPaymentProviderSSOT.ts";

const InputSchema = z.object({
  trip_id: z.string().uuid(),
  trip_code: z.string().optional(),
});

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const gate = await requireAdmin(req);
    if (!gate.ok) return gate.response;

    let body: unknown;
    try { body = await req.json(); } catch { return jsonResponse({ error: "Invalid JSON body" }, 400); }
    const parsed = InputSchema.safeParse(body);
    if (!parsed.success) return jsonResponse({ error: "Invalid input", details: parsed.error.flatten() }, 400);
    const { trip_id } = parsed.data;

    const { data: trip, error: tripErr } = await gate.supabase
      .from("trips")
      .select("id, payment_provider, provider_order_id, stripe_payment_intent_id, commission_pence")
      .eq("id", trip_id)
      .single();
    if (tripErr || !trip) return jsonResponse({ error: "Trip not found" }, 404);

    const provider = resolveTripPaymentProvider(trip);
    if (provider === "revolut") {
      return jsonResponse({
        error: "Revolut trips sync from Revolut webhook/DB — Stripe sync is for legacy trips only",
        error_code: "PROVIDER_SYNC_NOT_APPLICABLE",
        payment_provider: "revolut",
      }, 422);
    }
    if (provider !== "stripe") {
      return jsonResponse({ error: "Trip has no identifiable payment provider reference" }, 400);
    }

    const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!stripeKey) return jsonResponse({ error: "STRIPE_SECRET_KEY not configured" }, 500);

    const result = await adminLegacyStripeSyncFromProvider({
      supabase: gate.supabase,
      userId: gate.userId,
      trip,
      stripeKey,
    });
    return jsonResponse(result);
  } catch (e) {
    console.error("[admin-sync-trip-payment-from-stripe] Error:", e);
    return jsonResponse({ error: (e as Error).message ?? String(e) }, 500);
  }
});
