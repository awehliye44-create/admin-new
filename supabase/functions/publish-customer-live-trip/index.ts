/**
 * Service-role: upsert Live Trip projection + fan-out ActivityKit APNs / Android FCM data.
 * Presentation delivery only — never blocks trip mutations / payments.
 */
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  handleCORSPreflight,
  checkRateLimit,
  getClientIP,
  rateLimitResponse,
  isValidUUID,
  validationErrorResponse,
  successResponse,
  errorResponse,
} from "../_shared/security.ts";
import { requireAdminOrService } from "../_shared/callerGate.ts";
import { buildCustomerLiveTripProjection } from "../_shared/customerLiveTripProjectionSSOT.ts";
import {
  liveActivityApnsConfigured,
  sendCustomerLiveActivityApns,
} from "../_shared/customerLiveTripApns.ts";
import {
  fcmProjectIdFromServiceAccount,
  getFcmHttpV1AccessToken,
  readFcmServiceAccountJson,
  sendFcmHttpV1Message,
} from "../_shared/fcmHttpV1.ts";
import { resolveCustomerAuthoritativeToken } from "../_shared/authoritativeDevicePush.ts";

const RATE = { limit: 400, windowMs: 60_000, keyPrefix: "pub-live-trip" };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleCORSPreflight();
  const gate = await requireAdminOrService(req);
  if (!gate.ok) return gate.response;

  const clientIP = getClientIP(req);
  const rl = checkRateLimit(clientIP, RATE);
  if (!rl.allowed) return rateLimitResponse(rl);

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(SUPABASE_URL, SERVICE);
    const body = await req.json();
    const tripId = String(body.trip_id ?? body.tripId ?? "").trim();
    if (!tripId || !isValidUUID(tripId)) {
      return validationErrorResponse({ trip_id: "trip_id UUID required" });
    }

    const { data: trip, error: tripErr } = await admin
      .from("trips")
      .select("*")
      .eq("id", tripId)
      .maybeSingle();
    if (tripErr || !trip) {
      return errorResponse("TRIP_NOT_FOUND", "Trip not found", 404);
    }

    // Resolve customer auth user id.
    let customerUserId =
      String(trip.customer_user_id ?? trip.user_id ?? "").trim() || "";
    const customerId = String(trip.customer_id ?? trip.passenger_id ?? "").trim() ||
      null;
    if (!customerUserId && customerId && isValidUUID(customerId)) {
      const { data: cust } = await admin
        .from("customers")
        .select("user_id")
        .eq("id", customerId)
        .maybeSingle();
      customerUserId = String(cust?.user_id ?? "").trim();
    }
    if (!customerUserId) {
      return errorResponse("CUSTOMER_UNRESOLVED", "Cannot resolve customer user", 400);
    }

    const { data: previous } = await admin
      .from("customer_live_trip_projections")
      .select("*")
      .eq("trip_id", tripId)
      .maybeSingle();

    const projection = buildCustomerLiveTripProjection({
      trip: trip as Record<string, unknown>,
      customerUserId,
      customerId,
      previous: previous as Record<string, unknown> | null,
    });
    if (!projection) {
      return errorResponse("PROJECTION_FAILED", "Could not build projection", 500);
    }

    const { error: upsertErr } = await admin
      .from("customer_live_trip_projections")
      .upsert({
        ...projection,
        last_published_at: new Date().toISOString(),
      });
    if (upsertErr) {
      console.error("[publish-customer-live-trip] upsert", upsertErr);
      // Do not fail trip producers hard — still attempt best-effort fanout.
    }

    const delivery: Record<string, unknown> = {
      apns_attempted: false,
      apns_ok: false,
      fcm_attempted: false,
      fcm_ok: false,
    };

    // iOS ActivityKit — only when eligible or terminal end.
    if (liveActivityApnsConfigured()) {
      const { data: tokens } = await admin
        .from("customer_live_activity_tokens")
        .select("push_token, trip_id")
        .eq("customer_user_id", customerUserId)
        .is("invalidated_at", null)
        .or(`trip_id.eq.${tripId},trip_id.is.null`);

      const nowSec = Math.floor(Date.now() / 1000);
      const staleSec = projection.stale_at
        ? Math.floor(Date.parse(projection.stale_at) / 1000)
        : nowSec + 8 * 60;

      for (const row of tokens ?? []) {
        const token = String(row.push_token ?? "").trim();
        if (!token) continue;
        delivery.apns_attempted = true;
        const event =
          projection.terminal || !projection.eligible ? "end" : "update";
        const result = await sendCustomerLiveActivityApns({
          pushToken: token,
          event,
          timestampSec: nowSec,
          contentState: projection.content_state,
          staleDateSec: event === "update" ? staleSec : undefined,
          dismissalDateSec: event === "end" ? nowSec + 60 : undefined,
        });
        delivery.apns_ok = Boolean(delivery.apns_ok) || result.ok;
        if (!result.ok && result.status === 410) {
          await admin
            .from("customer_live_activity_tokens")
            .update({ invalidated_at: new Date().toISOString() })
            .eq("push_token", token);
        }
      }
    }

    // Android: data-only FCM for native LiveTrip handler (no alert / sound).
    const serviceAccountJson = readFcmServiceAccountJson();
    if (serviceAccountJson) {
      try {
        const authToken = await resolveCustomerAuthoritativeToken(
          admin,
          customerUserId,
        );
        if (authToken?.token && authToken.platform !== "ios") {
          delivery.fcm_attempted = true;
          const access = await getFcmHttpV1AccessToken(serviceAccountJson);
          const projectId = fcmProjectIdFromServiceAccount(serviceAccountJson);
          const data: Record<string, string> = {
            type: "live_trip_update",
            trip_id: tripId,
            assignment_generation: String(projection.assignment_generation),
            presentation_version: String(projection.presentation_version),
            eligible: projection.eligible ? "1" : "0",
            terminal: projection.terminal ? "1" : "0",
            content_state: JSON.stringify(projection.content_state),
          };
          const send = await sendFcmHttpV1Message({
            accessToken: access,
            projectId,
            message: {
              token: authToken.token,
              data,
              android: { priority: "HIGH" },
            },
          });
          delivery.fcm_ok = send.ok;
        }
      } catch (err) {
        console.warn(
          "[publish-customer-live-trip] fcm fanout",
          err instanceof Error ? err.message : "unknown",
        );
      }
    }

    return successResponse({
      ok: true,
      trip_id: tripId,
      eligible: projection.eligible,
      terminal: projection.terminal,
      assignment_generation: projection.assignment_generation,
      presentation_version: projection.presentation_version,
      lifecycle_stage: projection.lifecycle_stage,
      delivery,
    });
  } catch (err) {
    console.error("[publish-customer-live-trip] exception", err);
    return errorResponse(
      "INTERNAL",
      err instanceof Error ? err.message : "unknown",
      500,
    );
  }
});
