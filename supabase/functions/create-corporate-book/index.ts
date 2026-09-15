/**
 * Corporate booking idempotency companion (payment-first).
 *
 * One stable client_action_id → one payment_session → one provider order →
 * at most one trip (via existing create-trip-after-payment / session finalize).
 *
 * Never trusts client-supplied fare amounts as authority — re-quotes via
 * calculate-fare when coordinates are present; otherwise refuses.
 *
 * Does NOT use the legacy trip-first payment Edge.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { loadPaymentSession } from "../_shared/paymentSessionSSOT.ts";
import { createRevolutPreauthResponse } from "../_shared/revolutPreauth.ts";
import {
  findCorporateScheduleOverlap,
  type CorporateOverlapTrip,
} from "../_shared/corporateScheduleOverlapSSOT.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json(401, { error: "Missing authorization" });

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const authClient = createClient(supabaseUrl, anon, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authError } = await authClient.auth.getUser();
    if (authError || !user) return json(401, { error: "Unauthorized" });

    const body = await req.json();
    const clientActionId = String(body.client_action_id ?? "").trim();
    const corporateAccountId = String(body.corporate_account_id ?? "").trim();
    const serviceAreaId = String(body.service_area_id ?? "").trim();
    const vehicleTypeId = String(body.vehicle_type_id ?? "").trim();
    const paymentMethod = String(body.payment_method ?? "card").toLowerCase();
    const scheduledAt = body.scheduled_at ? String(body.scheduled_at) : null;
    const reconcileOnly = body.reconcile_only === true;

    if (!clientActionId) {
      return json(400, { error: "client_action_id is required", code: "CLIENT_ACTION_ID_REQUIRED" });
    }
    if (!corporateAccountId || !serviceAreaId) {
      return json(400, { error: "corporate_account_id and service_area_id are required" });
    }

    const admin = createClient(supabaseUrl, serviceKey);

    const { data: membership } = await admin
      .from("corporate_user_accounts")
      .select("role")
      .eq("user_id", user.id)
      .eq("corporate_account_id", corporateAccountId)
      .maybeSingle();
    if (!membership) {
      return json(403, { error: "Forbidden", code: "CORPORATE_ACCESS_DENIED" });
    }

    // ── Reconcile first (unknown outcome / retry / refresh) ───────────────
    const existingSession = await loadPaymentSession(admin, { clientActionId });
    if (existingSession) {
      const tripId = existingSession.trip_id ? String(existingSession.trip_id) : null;
      return json(200, {
        client_action_id: clientActionId,
        payment_session_id: existingSession.id,
        provider_order_id: existingSession.provider_order_id ?? null,
        provider_checkout_token: existingSession.provider_checkout_token ??
          existingSession.provider_client_token ?? null,
        trip_id: tripId,
        status: existingSession.status,
        idempotent: true,
      });
    }

    // Trip already stamped with this key (wallet/cash or prior finalize)
    const { data: existingTrip } = await admin
      .from("trips")
      .select("id, status, provider_order_id")
      .eq("client_action_id", clientActionId)
      .maybeSingle();
    if (existingTrip) {
      return json(200, {
        client_action_id: clientActionId,
        payment_session_id: null,
        provider_order_id: (existingTrip as any).provider_order_id ?? null,
        trip_id: existingTrip.id,
        status: existingTrip.status,
        idempotent: true,
      });
    }

    if (reconcileOnly) {
      return json(404, {
        error: "No payment session or trip for client_action_id",
        code: "NOT_FOUND",
        client_action_id: clientActionId,
      });
    }

    // ── Schedule overlap (atomic with create path) ────────────────────────
    if (scheduledAt) {
      if (!Number.isFinite(Date.parse(scheduledAt))) {
        return json(400, { error: "scheduled_at must be a valid ISO timestamp" });
      }
      const durationMinutes = Math.max(
        1,
        Number(body.estimated_duration_minutes ?? 30),
      );
      const { data: rows, error: ovErr } = await admin
        .from("trips")
        .select("id, scheduled_at, estimated_duration_minutes, status, passenger_id, corporate_account_id")
        .eq("corporate_account_id", corporateAccountId)
        .not("scheduled_at", "is", null)
        .limit(200);
      if (ovErr) {
        return json(500, { error: "Unable to check schedule overlap" });
      }
      const overlap = findCorporateScheduleOverlap({
        candidateScheduledAt: scheduledAt,
        candidateDurationMinutes: durationMinutes,
        existing: (rows ?? []) as CorporateOverlapTrip[],
      });
      if (overlap.has_conflict) {
        return json(409, { ...overlap, code: "SCHEDULE_OVERLAP" });
      }
    }

    // ── Server-authoritative fare (never trust client amount) ─────────────
    const pickupLat = Number(body.pickup_latitude);
    const pickupLng = Number(body.pickup_longitude);
    const dropoffLat = Number(body.dropoff_latitude);
    const dropoffLng = Number(body.dropoff_longitude);
    if (![pickupLat, pickupLng, dropoffLat, dropoffLng].every(Number.isFinite)) {
      return json(400, {
        error: "pickup/dropoff coordinates required for server fare quote",
        code: "FARE_COORDINATES_REQUIRED",
      });
    }

    const fareRes = await fetch(`${supabaseUrl}/functions/v1/calculate-fare`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceKey}`,
        apikey: serviceKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        service_area_id: serviceAreaId,
        vehicle_type_id: vehicleTypeId || undefined,
        pickup: { lat: pickupLat, lng: pickupLng },
        dropoff: { lat: dropoffLat, lng: dropoffLng },
        stops: Array.isArray(body.stops) ? body.stops : [],
        source: "corporate_portal",
      }),
    });
    const fareBody = await fareRes.json().catch(() => ({}));
    if (!fareRes.ok) {
      return json(502, {
        error: "Unable to calculate fare",
        code: "FARE_QUOTE_FAILED",
      });
    }
    const estimatedFarePence = Math.round(
      Number(
        fareBody.estimated_fare_pence ??
          (fareBody.estimatedFare != null ? Number(fareBody.estimatedFare) * 100 : NaN) ??
          (fareBody.estimated_fare != null ? Number(fareBody.estimated_fare) * 100 : NaN),
      ),
    );
    if (!Number.isFinite(estimatedFarePence) || estimatedFarePence <= 0) {
      return json(502, { error: "Invalid server fare quote", code: "FARE_QUOTE_INVALID" });
    }

    // Reject mismatched client display amount if provided (informational only)
    if (body.client_displayed_fare_pence != null) {
      const clientPence = Math.round(Number(body.client_displayed_fare_pence));
      if (Number.isFinite(clientPence) && Math.abs(clientPence - estimatedFarePence) > 1) {
        return json(409, {
          error: "Displayed fare is stale; refresh quote and retry",
          code: "FARE_MISMATCH",
          server_fare_pence: estimatedFarePence,
        });
      }
    }

    if (paymentMethod !== "card") {
      // Wallet/invoice: still require the key; trip insert stays on a follow-up
      // path once card idempotency lands. Fail closed rather than trip-first insert.
      return json(501, {
        error: "Non-card corporate booking via create-corporate-book is not enabled in this companion yet",
        code: "PAYMENT_METHOD_NOT_IMPLEMENTED",
        client_action_id: clientActionId,
      });
    }

    const { data: sa } = await admin
      .from("service_areas")
      .select("id, currency, financial_model")
      .eq("id", serviceAreaId)
      .maybeSingle();
    const currency = String((sa as any)?.currency ?? "GBP").toUpperCase();
    const financialModel = String((sa as any)?.financial_model ?? "");
    if (financialModel && financialModel !== "PLATFORM_COLLECTED") {
      return json(409, {
        error: "Corporate card preauth requires PLATFORM_COLLECTED",
        code: "FINANCIAL_MODEL_VIOLATION",
      });
    }

    const logStep = (step: string, details?: unknown) => {
      console.log(JSON.stringify({ fn: "create-corporate-book", step, details }));
    };

    const bookingSnapshot = {
      client_action_id: clientActionId,
      corporate_account_id: corporateAccountId,
      service_area_id: serviceAreaId,
      vehicle_type_id: vehicleTypeId,
      pickup: {
        address: body.pickup_address ?? "",
        lat: pickupLat,
        lng: pickupLng,
      },
      dropoff: {
        address: body.dropoff_address ?? "",
        lat: dropoffLat,
        lng: dropoffLng,
      },
      passenger_name: body.passenger_name ?? null,
      passenger_phone: body.passenger_phone ?? null,
      scheduled_at: scheduledAt,
      booking_source: "corporate_portal",
      payment_intent_id: null,
    };

    const fareSnapshot = {
      estimated_fare_pence: estimatedFarePence,
      currency,
      source: "calculate-fare",
    };

    // Payment-first Revolut preauth keyed by client_action_id (session upsert onConflict).
    return await createRevolutPreauthResponse({
      supabase: admin,
      environment: (Deno.env.get("REVOLUT_ENVIRONMENT") as "sandbox" | "production") || "sandbox",
      authorisedAmountPence: estimatedFarePence,
      estimatedTotalPence: estimatedFarePence,
      bufferPence: 0,
      paymentCurrency: currency,
      tripId: null,
      clientActionId,
      idempotencyKeySuffix: clientActionId,
      metadataExtra: {
        client_action_id: clientActionId,
        corporate_account_id: corporateAccountId,
        service_area_id: serviceAreaId,
        vehicle_type_id: vehicleTypeId,
        booking_source: "corporate_portal",
        gross_fare_pence: String(estimatedFarePence),
        final_fare_pence: String(estimatedFarePence),
      },
      paymentMethodType: "card",
      userId: user.id,
      bookingSnapshot,
      fareSnapshot,
      customerEmail: user.email ?? null,
      customerName: body.passenger_name ? String(body.passenger_name) : null,
      corsHeaders,
      logStep,
    });
  } catch (e) {
    console.error("create-corporate-book", e);
    return json(500, { error: "Internal error" });
  }
});
