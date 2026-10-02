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
import { requireAdminOrService, escapeHtml } from "../_shared/callerGate.ts";
import {
  fcmProjectIdFromServiceAccount,
  getFcmHttpV1AccessToken,
  readFcmServiceAccountJson,
  sendFcmHttpV1Message,
} from "../_shared/fcmHttpV1.ts";
import {
  buildCustomerNotificationFcmMessage,
  isRawApnsDeviceToken,
} from "../_shared/customerNotificationPush.ts";

interface NotificationPayload {
  customer_id?: string;
  /** Alias used by some Edge producers — same as customer_id / passenger auth id. */
  passengerId?: string;
  passenger_id?: string;
  title: string;
  body: string;
  type?: string;
  data?: Record<string, string>;
}

const RATE_LIMIT_CONFIG = { limit: 200, windowMs: 60000, keyPrefix: 'send-customer-notif' };

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return handleCORSPreflight();
  }
  const callerGate = await requireAdminOrService(req);
  if (!callerGate.ok) return callerGate.response;

  const clientIP = getClientIP(req);
  const rateLimitResult = checkRateLimit(clientIP, RATE_LIMIT_CONFIG);
  if (!rateLimitResult.allowed) {
    return rateLimitResponse(rateLimitResult);
  }

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const serviceAccountJson = readFcmServiceAccountJson();

    if (!serviceAccountJson) {
      console.error("[send-customer-notification] GOOGLE_SERVICE_ACCOUNT_JSON not configured");
      return errorResponse("FCM_NOT_CONFIGURED", "FCM not configured", 500);
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const payload: NotificationPayload = await req.json();
    const customerId = (
      payload.customer_id ??
      payload.passengerId ??
      payload.passenger_id ??
      ""
    ).trim();

    console.log("[send-customer-notification] Received:", {
      customer_id: customerId || null,
      type: payload.type,
      title: payload.title,
    });

    // Validation
    const validationErrors: Record<string, string> = {};
    if (!customerId) {
      validationErrors.customer_id = "customer_id is required";
    } else if (!isValidUUID(customerId)) {
      validationErrors.customer_id = "customer_id must be a valid UUID";
    }
    if (!payload.title) validationErrors.title = "title is required";
    if (!payload.body) validationErrors.body = "body is required";

    if (Object.keys(validationErrors).length > 0) {
      return validationErrorResponse(validationErrors);
    }

    const sanitizedTitle = sanitizeString(payload.title, 100) || 'Notification';
    const sanitizedBody = sanitizeString(payload.body, 500) || '';

    // Resolve customers.id → auth user_id when needed (token rows key on auth user).
    let authUserId = customerId;
    const { data: customerRow } = await supabase
      .from("customers")
      .select("user_id")
      .eq("id", customerId)
      .maybeSingle();
    if (typeof customerRow?.user_id === "string" && customerRow.user_id.trim()) {
      authUserId = customerRow.user_id.trim();
    }

    // Get customer's push tokens (authoritative device preferred when available)
    const { resolveCustomerAuthoritativeToken } = await import(
      "../_shared/authoritativeDevicePush.ts"
    );
    const authoritative = await resolveCustomerAuthoritativeToken(supabase, authUserId);
    const tokens = authoritative?.token
      ? [{ token: authoritative.token, platform: authoritative.platform }]
      : (
        await supabase
          .from("customer_push_tokens")
          .select("token, platform")
          .eq("user_id", authUserId)
          .eq("app_type", "customer")
      ).data;

    if (!tokens || tokens.length === 0) {
      console.log("[send-customer-notification] No tokens for customer:", authUserId);
      return errorResponse("NO_TOKENS", "No push tokens found", 404, { sent: 0 });
    }

    console.log(`[send-customer-notification] Found ${tokens.length} token(s)`);

    let projectId: string;
    let accessToken: string;
    try {
      projectId = fcmProjectIdFromServiceAccount(serviceAccountJson);
      accessToken = await getFcmHttpV1AccessToken(serviceAccountJson);
    } catch (err) {
      console.error(
        "[send-customer-notification] FCM v1 auth failed:",
        err instanceof Error ? err.message.slice(0, 200) : "unknown",
      );
      return errorResponse("FCM_AUTH_FAILED", "FCM authentication failed", 500);
    }

    const results = await Promise.all(
      tokens.map(async ({ token, platform }) => {
        if (isRawApnsDeviceToken(token)) {
          console.warn(`[send-customer-notification] Skipped raw APNs token (${platform}) — not an FCM registration token`);
          return { platform, success: false, error: "RAW_APNS_TOKEN" };
        }

        const message = buildCustomerNotificationFcmMessage({
          token,
          platform,
          title: sanitizedTitle,
          body: sanitizedBody,
          type: payload.type,
          data: payload.data,
        });

        try {
          const result = await sendFcmHttpV1Message({ projectId, accessToken, message });
          if (result.ok) {
            return { platform, success: true };
          }

          console.warn(
            `[send-customer-notification] FCM v1 failed (${platform}): http=${result.httpStatus} code=${result.errorCode}`,
          );
          if (result.tokenDead) {
            console.log("[send-customer-notification] Removing unregistered token");
            await supabase.from("customer_push_tokens").delete().eq("token", token);
          }
          return { platform, success: false, error: result.errorCode };
        } catch (err) {
          console.error(`[send-customer-notification] FCM error (${platform}):`, err);
          return { platform, success: false, error: String(err) };
        }
      })
    );

    const successCount = results.filter(r => r.success).length;
    console.log(`[send-customer-notification] Sent ${successCount}/${tokens.length}`);

    return successResponse({
      success: successCount > 0,
      sent: successCount,
      total: tokens.length,
      results,
    });
  } catch (err) {
    console.error("[send-customer-notification] Unexpected error:", err);
    return errorResponse("INTERNAL_ERROR", String(err), 500);
  }
});
