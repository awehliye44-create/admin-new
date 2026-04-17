/**
 * apply-offer
 * Validates and computes the discount for a customer offer at estimate-time
 * and at trip-completion time. The discount is applied ONLY to the ride fare
 * (excludes waiting fees, cancellation fees, no-show fees, tolls, tips).
 *
 * Modes:
 *   mode = 'preview'  -> only compute, no write (used by estimate-fare/UI)
 *   mode = 'apply'    -> write a redemption row + bump usage_count
 *                       (used by complete-trip / capture-trip-payment)
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface ApplyOfferRequest {
  offer_id?: string;
  offer_code?: string;
  service_area_id: string;
  ride_fare_pence: number; // base ride fare ONLY (no waiting/tolls/tips)
  customer_id?: string;
  trip_id?: string;
  mode: "preview" | "apply";
}

interface ApplyOfferResult {
  ok: boolean;
  reason?: string;
  offer_id?: string;
  offer_code?: string;
  discount_pence?: number;
  final_fare_pence?: number;
  currency?: string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = (await req.json()) as ApplyOfferRequest;
    const {
      offer_id,
      offer_code,
      service_area_id,
      ride_fare_pence,
      customer_id,
      trip_id,
      mode,
    } = body;

    if (!offer_id && !offer_code) {
      return json({ ok: false, reason: "OFFER_IDENTIFIER_REQUIRED" }, 400);
    }
    if (!service_area_id) return json({ ok: false, reason: "SERVICE_AREA_REQUIRED" }, 400);
    if (typeof ride_fare_pence !== "number" || ride_fare_pence < 0) {
      return json({ ok: false, reason: "INVALID_FARE" }, 400);
    }
    if (mode !== "preview" && mode !== "apply") {
      return json({ ok: false, reason: "INVALID_MODE" }, 400);
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // --- Identify caller (for per-user limits / new-customer checks) ---
    const authHeader = req.headers.get("authorization");
    let user_id: string | null = null;
    if (authHeader) {
      const token = authHeader.replace("Bearer ", "");
      const { data: u } = await supabase.auth.getUser(token);
      user_id = u?.user?.id ?? null;
    }

    // --- Load offer ---
    const offerQuery = supabase.from("offers").select("*").limit(1);
    const { data: offerRows, error: offerErr } = offer_id
      ? await offerQuery.eq("id", offer_id)
      : await offerQuery.eq("code", offer_code!.toUpperCase().trim());

    if (offerErr || !offerRows?.length) {
      return json({ ok: false, reason: "OFFER_NOT_FOUND" }, 404);
    }
    const offer = offerRows[0];

    // --- Status / window checks ---
    const now = Date.now();
    if (!offer.is_enabled || offer.status !== "active") {
      return json({ ok: false, reason: "OFFER_DISABLED" });
    }
    if (new Date(offer.starts_at).getTime() > now) {
      return json({ ok: false, reason: "OFFER_NOT_YET_ACTIVE" });
    }
    if (offer.ends_at && new Date(offer.ends_at).getTime() <= now) {
      return json({ ok: false, reason: "OFFER_EXPIRED" });
    }

    // --- Service-area scope ---
    const { data: scope } = await supabase
      .from("offer_service_areas")
      .select("service_area_id")
      .eq("offer_id", offer.id);
    if (scope && scope.length > 0) {
      const allowed = scope.some((s) => s.service_area_id === service_area_id);
      if (!allowed) return json({ ok: false, reason: "OFFER_NOT_IN_AREA" });
    } // else: global offer

    // --- Min fare ---
    if (ride_fare_pence < (offer.min_fare_pence ?? 0)) {
      return json({ ok: false, reason: "MIN_FARE_NOT_MET" });
    }

    // --- Total usage limit ---
    if (
      typeof offer.total_usage_limit === "number" &&
      offer.usage_count >= offer.total_usage_limit
    ) {
      return json({ ok: false, reason: "OFFER_USAGE_EXHAUSTED" });
    }

    // --- Per-user limit / first-ride-only / new-customer-only ---
    if (user_id) {
      if (offer.per_user_limit) {
        const { count } = await supabase
          .from("offer_redemptions")
          .select("id", { count: "exact", head: true })
          .eq("offer_id", offer.id)
          .eq("user_id", user_id)
          .eq("status", "applied");
        if ((count ?? 0) >= offer.per_user_limit) {
          return json({ ok: false, reason: "USER_LIMIT_REACHED" });
        }
      }
      if (offer.first_ride_only || offer.new_customer_only) {
        const { count: tripCount } = await supabase
          .from("trips")
          .select("id", { count: "exact", head: true })
          .eq("customer_id", customer_id ?? "00000000-0000-0000-0000-000000000000")
          .in("status", ["COMPLETED", "completed"]);
        if ((tripCount ?? 0) > 0) {
          return json({ ok: false, reason: "NOT_FIRST_RIDE" });
        }
      }
    }

    // --- Compute discount ---
    let discount_pence = 0;
    if (offer.offer_type === "percent_discount") {
      discount_pence = Math.floor((ride_fare_pence * Number(offer.discount_value)) / 100);
    } else {
      // fixed_amount_discount: discount_value is in major units (e.g. £2 -> 200p)
      discount_pence = Math.floor(Number(offer.discount_value) * 100);
    }
    if (offer.max_discount_pence != null) {
      discount_pence = Math.min(discount_pence, offer.max_discount_pence);
    }
    discount_pence = Math.max(0, Math.min(discount_pence, ride_fare_pence));
    const final_fare_pence = ride_fare_pence - discount_pence;

    const result: ApplyOfferResult = {
      ok: true,
      offer_id: offer.id,
      offer_code: offer.code,
      discount_pence,
      final_fare_pence,
      currency: offer.currency,
    };

    // --- Persist on apply mode ---
    if (mode === "apply") {
      const { error: insErr } = await supabase.from("offer_redemptions").insert({
        offer_id: offer.id,
        customer_id: customer_id ?? null,
        user_id: user_id,
        trip_id: trip_id ?? null,
        service_area_id,
        discount_pence,
        original_fare_pence: ride_fare_pence,
        final_fare_pence,
        currency: offer.currency,
        status: "applied",
      });
      if (insErr) {
        console.error("[apply-offer] insert redemption failed", insErr);
        return json({ ok: false, reason: "REDEMPTION_WRITE_FAILED" }, 500);
      }
      await supabase
        .from("offers")
        .update({ usage_count: (offer.usage_count ?? 0) + 1 })
        .eq("id", offer.id);
    }

    return json(result);
  } catch (e) {
    console.error("[apply-offer] error", e);
    return json({ ok: false, reason: "INTERNAL_ERROR" }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
