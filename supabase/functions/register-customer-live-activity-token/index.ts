/**
 * Authenticated Customer ActivityKit push-token register/rotate.
 * Bound to authoritative customer_active_devices installation id.
 * Presentation-only — never mutates trip lifecycle.
 */
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  handleCORSPreflight,
  checkRateLimit,
  getClientIP,
  rateLimitResponse,
  isValidUUID,
  sanitizeString,
  validationErrorResponse,
  successResponse,
  errorResponse,
} from "../_shared/security.ts";

const RATE = { limit: 60, windowMs: 60_000, keyPrefix: "reg-live-activity" };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleCORSPreflight();

  const clientIP = getClientIP(req);
  const rl = checkRateLimit(clientIP, RATE);
  if (!rl.allowed) return rateLimitResponse(rl);

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) {
      return errorResponse("UNAUTHORIZED", "Missing bearer token", 401);
    }

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
    const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const userClient = createClient(SUPABASE_URL, ANON, {
      global: { headers: { Authorization: authHeader } },
    });
    const {
      data: { user },
      error: userErr,
    } = await userClient.auth.getUser();
    if (userErr || !user) {
      return errorResponse("UNAUTHORIZED", "Invalid session", 401);
    }

    const body = await req.json();
    const deviceId = sanitizeString(String(body.device_id ?? body.deviceId ?? ""), 128) ?? "";
    const pushToken = sanitizeString(String(body.push_token ?? body.pushToken ?? ""), 512);
    const pushToStart = sanitizeString(
      String(body.push_to_start_token ?? body.pushToStartToken ?? ""),
      512,
    );
    const tripIdRaw = String(body.trip_id ?? body.tripId ?? "").trim();
    const activityId = sanitizeString(String(body.activity_id ?? body.activityId ?? ""), 128);
    const bundleId =
      sanitizeString(String(body.bundle_id ?? body.bundleId ?? ""), 128) ||
      "com.onecab.customer.app";
    const apnsEnvironmentRaw = (sanitizeString(
      String(body.apns_environment ?? body.apnsEnvironment ?? ""),
      32,
    ) ?? "").toLowerCase();
    const apnsEnvironment =
      apnsEnvironmentRaw === "sandbox" || apnsEnvironmentRaw === "production"
        ? apnsEnvironmentRaw
        : null;
    const invalidate = body.invalidate === true;

    const errors: Record<string, string> = {};
    if (!deviceId) errors.device_id = "device_id is required";
    if (!invalidate && !pushToken && !pushToStart) {
      errors.push_token = "push_token or push_to_start_token is required";
    }
    if (tripIdRaw && !isValidUUID(tripIdRaw)) errors.trip_id = "trip_id must be a UUID";
    if (Object.keys(errors).length) return validationErrorResponse(errors);

    const admin = createClient(SUPABASE_URL, SERVICE);

    // Ownership: device must match authoritative active device for this user.
    // customer_active_devices stores installation id in `device_id` only —
    // do not select non-existent columns (PostgREST fails the whole lookup;
    // MK-261116-013 left customer_live_activity_tokens empty fleet-wide).
    const { data: activeDevice, error: deviceErr } = await admin
      .from("customer_active_devices")
      .select("device_id")
      .eq("user_id", user.id)
      .maybeSingle();
    if (deviceErr) {
      console.error("[register-customer-live-activity-token] device lookup", {
        message: deviceErr.message,
        code: deviceErr.code,
      });
      return errorResponse("DEVICE_LOOKUP_FAILED", "Device lookup failed", 500);
    }
    const authoritative = String(activeDevice?.device_id ?? "").trim();
    if (!authoritative || authoritative !== deviceId) {
      console.warn(
        "[register-customer-live-activity-token] device not authoritative",
        JSON.stringify({
          device_id_suffix: deviceId.slice(-8),
          has_active_row: Boolean(authoritative),
          active_suffix: authoritative ? authoritative.slice(-8) : null,
        }),
      );
      return errorResponse(
        "DEVICE_NOT_AUTHORITATIVE",
        "Live Activity token requires the authoritative active device",
        403,
      );
    }

    if (invalidate) {
      let q = admin
        .from("customer_live_activity_tokens")
        .update({ invalidated_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq("customer_user_id", user.id)
        .eq("device_id", deviceId)
        .is("invalidated_at", null);
      if (tripIdRaw) q = q.eq("trip_id", tripIdRaw);
      const { error } = await q;
      if (error) {
        console.error("[register-customer-live-activity-token] invalidate", error);
        return errorResponse("INVALIDATE_FAILED", error.message, 500);
      }
      return successResponse({ ok: true, invalidated: true });
    }

    // Preserve sibling token when rotating only one of activity / push-to-start.
    const { data: existing } = await admin
      .from("customer_live_activity_tokens")
      .select("push_token, push_to_start_token")
      .eq("customer_user_id", user.id)
      .eq("device_id", deviceId)
      .is("invalidated_at", null)
      .maybeSingle();
    const existingActivity = String(existing?.push_token ?? "").trim();
    const existingPts = String(existing?.push_to_start_token ?? "").trim();
    let resolvedPushToken = pushToken || existingActivity;
    let resolvedPushToStart = pushToStart || existingPts;
    // Drop legacy alias where push_token was a copy of push-to-start only.
    if (
      resolvedPushToken &&
      resolvedPushToStart &&
      resolvedPushToken === resolvedPushToStart &&
      !pushToken
    ) {
      resolvedPushToken = "";
    }
    if (!resolvedPushToken && !resolvedPushToStart) {
      return validationErrorResponse({
        push_token: "push_token or push_to_start_token is required",
      });
    }

    const row: Record<string, unknown> = {
      customer_user_id: user.id,
      device_id: deviceId,
      trip_id: tripIdRaw || null,
      activity_id: activityId || null,
      // Keep columns distinct: activity update token vs push-to-start.
      // When only PTS exists, store it in push_to_start_token and mirror into
      // push_token for NOT NULL / legacy readers — publish selects by event.
      push_token: resolvedPushToken || resolvedPushToStart,
      push_to_start_token: resolvedPushToStart || null,
      platform: "ios",
      bundle_id: bundleId,
      updated_at: new Date().toISOString(),
      invalidated_at: null,
    };
    if (apnsEnvironment) row.apns_environment = apnsEnvironment;

    const { error: upsertErr } = await admin
      .from("customer_live_activity_tokens")
      .upsert(row, { onConflict: "customer_user_id,device_id" });
    if (upsertErr) {
      console.error("[register-customer-live-activity-token] upsert", upsertErr);
      return errorResponse("UPSERT_FAILED", upsertErr.message, 500);
    }

    console.log(
      "[register-customer-live-activity-token] registered",
      JSON.stringify({
        device_id_suffix: deviceId.slice(-8),
        has_activity_token: Boolean(resolvedPushToken),
        has_push_to_start: Boolean(resolvedPushToStart),
        trip_id: tripIdRaw || null,
        apns_environment: apnsEnvironment,
      }),
    );
    return successResponse({ ok: true, registered: true });
  } catch (err) {
    console.error("[register-customer-live-activity-token] exception", err);
    return errorResponse(
      "INTERNAL",
      err instanceof Error ? err.message : "unknown",
      500,
    );
  }
});
