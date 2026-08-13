/**
 * bind-driver-device-token
 *
 * Authenticated Driver device-token bind/rotate for FCM (APNs via FCM on iOS).
 * Resolves driver_id from JWT — never trusts client-provided driver_id.
 *
 * ONE ACCOUNT = ONE ACTIVE DEVICE:
 * - claim=true (login / explicit takeover): claim_active_device semantics across ALL platforms
 * - claim=false (token refresh): only allowed if this installation is already authoritative
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { authenticateDriver } from "../_shared/driverAuth.ts";
import {
  buildTokenDeactivatePatch,
  isFcmRegistrationToken,
  parseDriverPushPlatform,
  tokenFingerprint,
  type DriverPushPlatform,
} from "../_shared/driverPushToken.ts";
import {
  checkRateLimit,
  errorResponse,
  getClientIP,
  handleCORSPreflight,
  rateLimitResponse,
  successResponse,
  validationErrorResponse,
} from "../_shared/security.ts";

const RATE_LIMIT_CONFIG = {
  limit: 30,
  windowMs: 60_000,
  keyPrefix: "bind-driver-device-token",
};

interface BindBody {
  push_token?: string;
  token?: string;
  platform?: string;
  installation_id?: string;
  device_id?: string;
  app_version?: string;
  environment?: string;
  app_identifier?: string;
  /** When true, this device becomes the sole active device (login takeover). */
  claim?: boolean;
  force_claim?: boolean;
  /** Ignored — server resolves from auth. */
  driver_id?: string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return handleCORSPreflight();
  }

  if (req.method !== "POST") {
    return errorResponse("METHOD_NOT_ALLOWED", "POST required", 405);
  }

  const rate = checkRateLimit(getClientIP(req), RATE_LIMIT_CONFIG);
  if (!rate.allowed) {
    return rateLimitResponse(rate.retryAfter!);
  }

  const auth = await authenticateDriver(req);
  if (auth instanceof Response) return auth;
  const { driverId, userId } = auth;

  let body: BindBody;
  try {
    body = (await req.json()) as BindBody;
  } catch {
    return validationErrorResponse({ body: "Invalid JSON body" });
  }

  if (body.driver_id && body.driver_id !== driverId) {
    console.warn(
      `[bind-driver-device-token] ignored client driver_id mismatch auth=${driverId}`,
    );
  }

  const platform = parseDriverPushPlatform(body.platform);
  if (!platform) {
    return validationErrorResponse({
      platform: "platform must be ios or android",
    });
  }

  const pushToken = String(body.push_token ?? body.token ?? "").trim();
  if (!pushToken) {
    return validationErrorResponse({ push_token: "push_token is required" });
  }
  if (!isFcmRegistrationToken(pushToken, platform)) {
    return validationErrorResponse({
      push_token:
        "push_token must be a valid FCM registration token (not Expo or raw APNs)",
    });
  }

  const installationId = String(
    body.installation_id ?? body.device_id ?? "",
  ).trim();
  if (!installationId || installationId.length < 8) {
    return validationErrorResponse({
      installation_id: "installation_id is required",
    });
  }

  const wantClaim = body.claim === true || body.force_claim === true;

  const appVersion =
    typeof body.app_version === "string" ? body.app_version.slice(0, 40) : null;

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const now = new Date().toISOString();
  const fp = tokenFingerprint(pushToken);

  const { data: activeDevice } = await supabase
    .from("driver_active_devices")
    .select("device_id")
    .eq("driver_id", driverId)
    .maybeSingle();

  const activeDeviceId =
    typeof activeDevice?.device_id === "string" ? activeDevice.device_id : null;

  // Token refresh / foreground rebind must NOT reclaim after another device took over.
  if (!wantClaim) {
    if (!activeDeviceId || activeDeviceId !== installationId) {
      console.warn(
        `[bind-driver-device-token] refresh rejected device_replaced driver=${driverId} installation=${installationId.slice(0, 8)}… active=${activeDeviceId?.slice(0, 8) ?? "none"}…`,
      );
      return errorResponse(
        "DEVICE_REPLACED",
        "This device is no longer the active Driver session",
        409,
        {
          active_device_id: activeDeviceId,
          installation_id: installationId,
        },
      );
    }
  }

  // If this token was bound to another driver, deactivate that binding.
  const { error: stealErr } = await supabase
    .from("push_tokens")
    .update(buildTokenDeactivatePatch("reassigned_to_another_driver"))
    .eq("token", pushToken)
    .eq("app_type", "driver")
    .neq("driver_id", driverId)
    .eq("is_active", true);
  if (stealErr) {
    console.warn(
      `[bind-driver-device-token] steal-deactivate failed fp=${fp}`,
      stealErr.message,
    );
  }

  // Authoritative claim (claim_active_device semantics) — sole active installation.
  const { error: claimErr } = await supabase.from("driver_active_devices").upsert(
    {
      driver_id: driverId,
      device_id: installationId,
      platform,
      last_seen_at: now,
      updated_at: now,
    },
    { onConflict: "driver_id" },
  );
  if (claimErr) {
    console.error(
      `[bind-driver-device-token] claim failed driver=${driverId}`,
      claimErr.message,
    );
    return errorResponse("CLAIM_FAILED", "Failed to claim active device", 500);
  }

  // Soft-deactivate EVERY active token for this driver first (all platforms).
  // Required before upsert so concurrent iOS+Android claims cannot both stay selectable.
  const { error: wipeErr } = await supabase
    .from("push_tokens")
    .update(buildTokenDeactivatePatch("replaced_by_active_device"))
    .eq("driver_id", driverId)
    .eq("app_type", "driver")
    .eq("is_active", true);
  if (wipeErr) {
    console.warn(
      `[bind-driver-device-token] wipe-active failed driver=${driverId}`,
      wipeErr.message,
    );
  }

  const row = {
    driver_id: driverId,
    user_id: userId,
    app_type: "driver",
    platform: platform as DriverPushPlatform,
    token: pushToken,
    device_id: installationId,
    app_version: appVersion,
    is_active: true,
    last_seen_at: now,
    last_failure_at: null,
    last_failure_reason: null,
    failure_count: 0,
    updated_at: now,
  };

  const { data: upserted, error: upsertErr } = await supabase
    .from("push_tokens")
    .upsert(row, { onConflict: "driver_id,platform,app_type" })
    .select("id, platform, device_id, is_active, last_seen_at, updated_at")
    .maybeSingle();

  if (upsertErr) {
    console.error(
      `[bind-driver-device-token] upsert failed driver=${driverId} fp=${fp}`,
      upsertErr.message,
    );
    return errorResponse("BIND_FAILED", "Failed to bind device token", 500);
  }

  // Final sole-token enforcement against concurrent bind races on another platform.
  const { error: soleErr } = await supabase
    .from("push_tokens")
    .update(buildTokenDeactivatePatch("replaced_by_active_device"))
    .eq("driver_id", driverId)
    .eq("app_type", "driver")
    .eq("is_active", true)
    .neq("token", pushToken);
  if (soleErr) {
    console.warn(
      `[bind-driver-device-token] sole-token enforce failed driver=${driverId}`,
      soleErr.message,
    );
  }

  // Presence hint only after authoritative claim + bind.
  await supabase
    .from("driver_presence")
    .update({ push_token: pushToken, platform, updated_at: now })
    .eq("driver_id", driverId);

  console.log(
    `[bind-driver-device-token] ok driver=${driverId} platform=${platform} claim=${wantClaim} installation=${installationId.slice(0, 8)}… fp=${fp}`,
  );

  return successResponse({
    bound: true,
    claimed: wantClaim || activeDeviceId === installationId,
    driver_id: driverId,
    platform,
    installation_id: installationId,
    token: upserted,
  });
});
