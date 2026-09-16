/**
 * Corporate booking idempotency companion (payment-first).
 *
 * Authority: membership + account status + assigned service area from server.
 * Never trusts client organisation_id / service_area / currency / fare.
 *
 * Scheduled path: rechecks overlap via corporateScheduleOverlapSSOT AND claims
 * the window via claim_corporate_schedule_hold (draft RPC) before payment state.
 * Does NOT call driver check_schedule_overlap.
 */
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { loadPaymentSession } from "../_shared/paymentSessionSSOT.ts";
import { createRevolutPreauthResponse } from "../_shared/revolutPreauth.ts";
import {
  findCorporateScheduleOverlap,
  type CorporateOverlapTrip,
} from "../_shared/corporateScheduleOverlapSSOT.ts";
import {
  resolveAuthoritativeCorporateAccountId,
  assertCorporateAccountBookable,
  assertServiceAreaInOrgScope,
  assertClientActionIdOrgBound,
  assertPaymentMethodAllowed,
} from "../_shared/corporateBookAuthoritySSOT.ts";

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
    const requestedOrgId = String(body.corporate_account_id ?? "").trim();
    const requestedServiceAreaId = String(body.service_area_id ?? "").trim();
    const vehicleTypeId = String(body.vehicle_type_id ?? "").trim();
    const paymentMethod = String(body.payment_method ?? "card").toLowerCase();
    const scheduledAt = body.scheduled_at ? String(body.scheduled_at) : null;
    const reconcileOnly = body.reconcile_only === true;

    if (!clientActionId) {
      return json(400, { error: "client_action_id is required", code: "CLIENT_ACTION_ID_REQUIRED" });
    }

    const admin = createClient(supabaseUrl, serviceKey);

    // ── Membership from authenticated identity (do not trust body org) ────
    const { data: membershipRows } = await admin
      .from("corporate_user_accounts")
      .select("corporate_account_id, role, user_id")
      .eq("user_id", user.id);

    const authz = resolveAuthoritativeCorporateAccountId({
      memberships: (membershipRows ?? []).map((r: any) => ({
        userId: String(r.user_id ?? user.id),
        corporateAccountId: String(r.corporate_account_id),
        role: String(r.role ?? "member"),
      })),
      requestedCorporateAccountId: requestedOrgId,
      userId: user.id,
    });
    if (!authz.ok) {
      return json(403, { error: "Forbidden", code: authz.code });
    }
    const corporateAccountId = authz.corporateAccountId;

    const { data: account } = await admin
      .from("corporate_accounts")
      .select("id, status, service_area_id")
      .eq("id", corporateAccountId)
      .maybeSingle();

    const bookable = assertCorporateAccountBookable(account as any);
    if (!bookable.ok) {
      return json(403, { error: "Organisation not bookable", code: bookable.code });
    }

    const assignedSa = String((account as any)?.service_area_id ?? "");
    const { data: sa } = await admin
      .from("service_areas")
      .select("id, currency, financial_model")
      .eq("id", assignedSa)
      .maybeSingle();

    const saGate = assertServiceAreaInOrgScope({
      account: account as any,
      requestedServiceAreaId: requestedServiceAreaId || assignedSa,
      serviceArea: sa as any,
      clientCurrency: body.client_currency ?? body.currency ?? null,
    });
    if (!saGate.ok) {
      return json(403, { error: "Service area / currency out of scope", code: saGate.code });
    }
    const serviceAreaId = assignedSa;
    const currency = saGate.currency;

    const payGate = assertPaymentMethodAllowed({
      method: paymentMethod,
      cardEnabled: true,
      walletImplementedAndEnabled: false,
      invoiceImplementedAndEnabled: false,
    });
    if (!payGate.ok) {
      return json(403, {
        error: "Payment method unavailable for Corporate bookings",
        code: payGate.code,
        message: "Card payment is the only supported method for this release.",
      });
    }

    // ── Reconcile first ───────────────────────────────────────────────────
    const existingSession = await loadPaymentSession(admin, { clientActionId });
    if (existingSession) {
      const sessionOrg = String(
        (existingSession.metadata as any)?.corporate_account_id ??
          (existingSession.booking_snapshot as any)?.corporate_account_id ??
          "",
      );
      const reuse = assertClientActionIdOrgBound({
        sessionCorporateAccountId: sessionOrg || null,
        authoritativeCorporateAccountId: corporateAccountId,
      });
      if (!reuse.ok) {
        return json(403, { error: "Forbidden", code: reuse.code });
      }
      return json(200, {
        client_action_id: clientActionId,
        payment_session_id: existingSession.id,
        provider_order_id: existingSession.provider_order_id ?? null,
        provider_checkout_token: existingSession.provider_checkout_token ??
          existingSession.provider_client_token ?? null,
        trip_id: existingSession.trip_id ? String(existingSession.trip_id) : null,
        status: existingSession.status,
        idempotent: true,
      });
    }

    const { data: existingTrip } = await admin
      .from("trips")
      .select("id, status, provider_order_id, corporate_account_id")
      .eq("client_action_id", clientActionId)
      .maybeSingle();
    if (existingTrip) {
      const reuse = assertClientActionIdOrgBound({
        sessionCorporateAccountId: String((existingTrip as any).corporate_account_id ?? ""),
        authoritativeCorporateAccountId: corporateAccountId,
      });
      if (!reuse.ok) {
        return json(403, { error: "Forbidden", code: reuse.code });
      }
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

    // ── Schedule: SSOT recheck + atomic claim before payment ──────────────
    const durationMinutes = Math.max(1, Number(body.estimated_duration_minutes ?? 30));
    if (scheduledAt) {
      if (!Number.isFinite(Date.parse(scheduledAt))) {
        return json(400, { error: "scheduled_at must be a valid ISO timestamp" });
      }

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

      // Atomic claim (draft RPC). Fail closed if unavailable — never race open.
      const { data: claim, error: claimErr } = await admin.rpc("claim_corporate_schedule_hold", {
        p_corporate_account_id: corporateAccountId,
        p_client_action_id: clientActionId,
        p_scheduled_at: scheduledAt,
        p_duration_minutes: durationMinutes,
        p_buffer_minutes: 15,
      });

      if (claimErr) {
        const msg = String(claimErr.message ?? claimErr);
        if (/could not find|PGRST202|does not exist|schema cache/i.test(msg)) {
          return json(503, {
            error: "Schedule claim RPC not applied",
            code: "SCHEDULE_CLAIM_UNAVAILABLE",
            message: "Authoritative schedule locking is not enabled in this environment yet.",
          });
        }
        return json(500, { error: "Schedule claim failed", code: "SCHEDULE_CLAIM_FAILED" });
      }

      const claimBody = claim as Record<string, unknown>;
      if (claimBody?.ok === false || claimBody?.code === "SCHEDULE_OVERLAP") {
        return json(409, {
          has_conflict: true,
          code: "SCHEDULE_OVERLAP",
          conflicting_trip_id: claimBody.conflicting_trip_id ?? null,
          conflicting_client_action_id: claimBody.conflicting_client_action_id ?? null,
        });
      }
    }

    // ── Server fare ───────────────────────────────────────────────────────
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
      return json(502, { error: "Unable to calculate fare", code: "FARE_QUOTE_FAILED" });
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

    const logStep = (step: string, details?: unknown) => {
      console.log(JSON.stringify({ fn: "create-corporate-book", step, details }));
    };

    const bookingSnapshot = {
      client_action_id: clientActionId,
      corporate_account_id: corporateAccountId,
      service_area_id: serviceAreaId,
      vehicle_type_id: vehicleTypeId,
      pickup: { address: body.pickup_address ?? "", lat: pickupLat, lng: pickupLng },
      dropoff: { address: body.dropoff_address ?? "", lat: dropoffLat, lng: dropoffLng },
      passenger_name: body.passenger_name ?? null,
      passenger_phone: body.passenger_phone ?? null,
      scheduled_at: scheduledAt,
      booking_source: "corporate_portal",
      payment_intent_id: null,
    };

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
      fareSnapshot: {
        estimated_fare_pence: estimatedFarePence,
        currency,
        source: "calculate-fare",
      },
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
