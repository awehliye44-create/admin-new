/**
 * unbind-driver-device-token
 *
 * Soft-deactivates the authenticated Driver's device token binding (logout / rotate).
 * Resolves driver_id from JWT — never trusts client-provided driver_id.
 * send-driver-notification only delivers to is_active=true rows.
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
  installation_id?: string;
  device_id?: string;
  push_token?: string;
  token?: string;
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
  const { driverId } = auth;

  let body: UnbindBody = {};
  try {
    body = (await req.json().catch(() => ({}))) as UnbindBody;
  } catch {
    body = {};
  }

  if (body.driver_id && body.driver_id !== driverId) {
    console.warn(
      `[unbind-driver-device-token] ignored client driver_id mismatch auth=${driverId}`,
    );
  }

  const installationId = String(
    body.installation_id ?? body.device_id ?? "",
  ).trim();
  const pushToken = String(body.push_token ?? body.token ?? "").trim();

  if (!installationId && !pushToken) {
    return validationErrorResponse({
      installation_id: "installation_id or push_token is required",
    });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const patch = buildTokenDeactivatePatch("driver_logout_unbind");
  let query = supabase
    .from("push_tokens")
    .update(patch)
    .eq("driver_id", driverId)
    .eq("app_type", "driver")
    .eq("is_active", true);

  if (installationId) {
    query = query.eq("device_id", installationId);
  }
  if (pushToken) {
    query = query.eq("token", pushToken);
  }

  const { data: updated, error } = await query.select("id, device_id");
  if (error) {
    console.error(
      `[unbind-driver-device-token] update failed driver=${driverId}`,
      error.message,
    );
    return errorResponse("UNBIND_FAILED", "Failed to unbind device token", 500);
  }

  if (pushToken) {
    const { data: presence } = await supabase
      .from("driver_presence")
      .select("push_token")
      .eq("driver_id", driverId)
      .maybeSingle();
    if (presence?.push_token === pushToken) {
      await supabase
        .from("driver_presence")
        .update({
          push_token: null,
          updated_at: new Date().toISOString(),
        })
        .eq("driver_id", driverId);
    }
  } else if ((updated?.length ?? 0) > 0) {
    await supabase
      .from("driver_presence")
      .update({
        push_token: null,
        updated_at: new Date().toISOString(),
      })
      .eq("driver_id", driverId);
  }

  console.log(
    `[unbind-driver-device-token] ok driver=${driverId} rows=${updated?.length ?? 0} fp=${
      pushToken ? tokenFingerprint(pushToken) : "n/a"
    }`,
  );

  return successResponse({
    unbound: true,
    deactivated_count: updated?.length ?? 0,
  });
});
