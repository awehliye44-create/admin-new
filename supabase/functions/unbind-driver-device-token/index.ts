/**
 * unbind-driver-device-token
 *
 * Authenticated Driver logout cleanup:
 * - deactivate this installation's push token(s)
 * - clear driver_active_devices when this installation was authoritative
 * - clear presence push_token hint when it matched
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { authenticateDriver } from "../_shared/driverAuth.ts";
import {
  buildTokenDeactivatePatch,
  tokenFingerprint,
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
  keyPrefix: "unbind-driver-device-token",
};

interface UnbindBody {
  push_token?: string;
  token?: string;
  installation_id?: string;
  device_id?: string;
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
  const { driverId } = auth;

  let body: UnbindBody = {};
  try {
    body = (await req.json()) as UnbindBody;
  } catch {
    body = {};
  }

  const installationId = String(
    body.installation_id ?? body.device_id ?? "",
  ).trim();
  if (!installationId || installationId.length < 8) {
    return validationErrorResponse({
      installation_id: "installation_id is required",
    });
  }

  const pushToken = String(body.push_token ?? body.token ?? "").trim();
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const now = new Date().toISOString();
  const patch = buildTokenDeactivatePatch("device_unbound_logout");

  let tokenQuery = supabase
    .from("push_tokens")
    .update(patch)
    .eq("driver_id", driverId)
    .eq("app_type", "driver")
    .eq("device_id", installationId)
    .eq("is_active", true);
  if (pushToken) {
    tokenQuery = tokenQuery.eq("token", pushToken);
  }
  const { error: tokenErr } = await tokenQuery;
  if (tokenErr) {
    console.error(
      `[unbind-driver-device-token] deactivate failed driver=${driverId}`,
      tokenErr.message,
    );
    return errorResponse("UNBIND_FAILED", "Failed to unbind device token", 500);
  }

  const { data: active } = await supabase
    .from("driver_active_devices")
    .select("device_id")
    .eq("driver_id", driverId)
    .maybeSingle();

  if (active?.device_id === installationId) {
    await supabase
      .from("driver_active_devices")
      .delete()
      .eq("driver_id", driverId)
      .eq("device_id", installationId);
  }

  // Clear presence hint if it pointed at this token / device.
  const { data: presence } = await supabase
    .from("driver_presence")
    .select("push_token")
    .eq("driver_id", driverId)
    .maybeSingle();

  if (
    !presence?.push_token ||
    !pushToken ||
    presence.push_token === pushToken
  ) {
    await supabase
      .from("driver_presence")
      .update({ push_token: null, updated_at: now })
      .eq("driver_id", driverId);
  }

  console.log(
    `[unbind-driver-device-token] ok driver=${driverId} installation=${installationId.slice(0, 8)}…${
      pushToken ? ` fp=${tokenFingerprint(pushToken)}` : ""
    }`,
  );

  return successResponse({
    unbound: true,
    driver_id: driverId,
    installation_id: installationId,
  });
});
