import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
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
import {
  resolveCustomerAuthUserId,
  resolveCustomerAuthoritativeToken,
} from "../_shared/authoritativeDevicePush.ts";

interface NotificationPayload {
  /** Auth user id OR customers.id — resolved via resolveCustomerAuthUserId. */
  customer_id?: string;
  /** Legacy alias used by scheduled-* / create-ride callers (customers.id). */
  passengerId?: string;
  customerId?: string;
  userId?: string;
  user_id?: string;
  title: string;
  body: string;
  type?: string;
  data?: Record<string, string>;
}

const RATE_LIMIT_CONFIG = { limit: 200, windowMs: 60000, keyPrefix: "send-customer-notif" };

function readCustomerIdHint(payload: NotificationPayload): string | null {
  for (const key of [
    "customer_id",
    "passengerId",
    "customerId",
    "userId",
    "user_id",
  ] as const) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return handleCORSPreflight();
  }

  const clientIP = getClientIP(req);
  const rateLimitResult = checkRateLimit(clientIP, RATE_LIMIT_CONFIG);
  if (!rateLimitResult.allowed) {
    return rateLimitResponse(rateLimitResult);
  }

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const FCM_SERVER_KEY = Deno.env.get("FCM_SERVER_KEY");

    if (!FCM_SERVER_KEY) {
      console.error("[send-customer-notification] FCM_SERVER_KEY not configured");
      return errorResponse("FCM_NOT_CONFIGURED", "FCM not configured", 500);
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const payload: NotificationPayload = await req.json();
    const customerIdHint = readCustomerIdHint(payload);

    console.log("[send-customer-notification] Received:", {
      customer_id_hint: customerIdHint,
      type: payload.type,
      title: payload.title,
    });

    const validationErrors: Record<string, string> = {};
    if (!customerIdHint) {
      validationErrors.customer_id = "customer_id is required";
    } else if (!isValidUUID(customerIdHint)) {
      validationErrors.customer_id = "customer_id must be a valid UUID";
    }
    if (!payload.title) validationErrors.title = "title is required";
    if (!payload.body) validationErrors.body = "body is required";

    if (Object.keys(validationErrors).length > 0) {
      return validationErrorResponse(validationErrors);
    }

    // trips.passenger_id is customers.id; tokens / active devices are auth.users.id.
    const authUserId = await resolveCustomerAuthUserId(supabase, customerIdHint!);

    const sanitizedTitle = sanitizeString(payload.title, 100) || "Notification";
    const sanitizedBody = sanitizeString(payload.body, 500) || "";

    // Sole active device — never fan out to historical tokens.
    const authoritative = await resolveCustomerAuthoritativeToken(
      supabase,
      authUserId,
    );

    if (!authoritative?.token) {
      console.log(
        "[send-customer-notification] No authoritative token for customer:",
        authUserId,
      );
      return errorResponse("NO_TOKENS", "No push tokens found", 404, { sent: 0 });
    }

    console.log(
      `[send-customer-notification] Authoritative token platform=${authoritative.platform}`,
    );

    const fcmMessage: Record<string, unknown> = {
      to: authoritative.token,
      priority: "high",
      notification: {
        title: sanitizedTitle,
        body: sanitizedBody,
        sound: "default",
      },
      data: {
        type: payload.type || "trip_message",
        ...payload.data,
      },
    };

    if (authoritative.platform === "ios") {
      fcmMessage.content_available = true;
    }

    try {
      const response = await fetch("https://fcm.googleapis.com/fcm/send", {
        method: "POST",
        headers: {
          Authorization: `key=${FCM_SERVER_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(fcmMessage),
      });

      const result = await response.json();
      console.log(
        `[send-customer-notification] FCM response (${authoritative.platform}):`,
        result,
      );

      if (result.failure === 1 && result.results?.[0]?.error === "NotRegistered") {
        console.log("[send-customer-notification] Removing invalid token");
        await supabase
          .from("customer_push_tokens")
          .delete()
          .eq("token", authoritative.token);
      }

      const success = result.success === 1;
      return successResponse({
        success,
        sent: success ? 1 : 0,
        total: 1,
        results: [
          {
            platform: authoritative.platform,
            success,
            error: result.results?.[0]?.error,
          },
        ],
      });
    } catch (err) {
      console.error(
        `[send-customer-notification] FCM error (${authoritative.platform}):`,
        err,
      );
      return errorResponse("FCM_SEND_FAILED", String(err), 500);
    }
  } catch (err) {
    console.error("[send-customer-notification] Unexpected error:", err);
    return errorResponse("INTERNAL_ERROR", String(err), 500);
  }
});
