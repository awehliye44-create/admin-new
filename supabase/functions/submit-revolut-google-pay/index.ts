/**
 * submit-revolut-google-pay
 *
 * Customer JWT → submit encrypted Google Pay token to Revolut Pay-for-order.
 * Does NOT treat submission as authorised — revolut-webhook / confirm-revolut-payment
 * remain authoritative for authorised_hold.
 *
 * Never logs the raw Google Pay token.
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  corsHeaders,
  checkRateLimit,
  getClientIP,
  rateLimitResponse,
  successResponse,
  errorResponse,
  logAuditEvent,
} from "../_shared/security.ts";
import {
  payRevolutOrderWithGooglePay,
  retrieveRevolutOrder,
  type GooglePayBillingAddress,
  type GooglePayBrowserEnvironment,
} from "../_shared/revolutOrders.ts";
import { resolveRevolutMerchantContext } from "../_shared/revolutMerchantContext.ts";
import {
  classifyGooglePaySubmitFailure,
  isFailedPaymentState,
  latestFailedPaymentDeclineReason,
} from "../_shared/googlePaySubmitOutcome.ts";

const RATE_LIMIT_CONFIG = { limit: 15, windowMs: 60 * 1000 };

async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Revolut client throws plain objects, not Error — never collapse to "pay_failed". */
function revolutFailureMessage(err: unknown): string {
  if (err instanceof Error && err.message.trim()) return err.message.trim();
  if (err && typeof err === "object") {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  return "pay_failed";
}

const ZERO_WIDTH = /[\u200B-\u200D\uFEFF]/g;
const UK_POSTCODE = /\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/i;

function normalizePostcode(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const cleaned = raw
    .replace(ZERO_WIDTH, "")
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
  if (!cleaned || cleaned === "NULL" || cleaned === "UNDEFINED" || cleaned === "000000") {
    return "";
  }
  return cleaned;
}

function extractUkPostcodeFromText(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const match = raw.replace(ZERO_WIDTH, "").match(UK_POSTCODE);
  if (!match?.[1]) return "";
  const compact = match[1].toUpperCase().replace(/\s+/g, "");
  if (compact.length < 5) return "";
  return `${compact.slice(0, compact.length - 3)} ${compact.slice(compact.length - 3)}`;
}

function mapBillingAddress(raw: unknown): GooglePayBillingAddress | null {
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Record<string, unknown>;
  const street1 =
    (typeof b.street_line_1 === "string" && b.street_line_1.trim()) ||
    (typeof b.address1 === "string" && b.address1.trim()) ||
    undefined;
  const street2 =
    (typeof b.street_line_2 === "string" && b.street_line_2.trim()) ||
    (typeof b.address2 === "string" && b.address2.trim()) ||
    undefined;
  const city =
    (typeof b.city === "string" && b.city.trim()) ||
    (typeof b.locality === "string" && b.locality.trim()) ||
    undefined;
  const region =
    (typeof b.region === "string" && b.region.trim()) ||
    (typeof b.administrativeArea === "string" && b.administrativeArea.trim()) ||
    undefined;
  let postcode =
    normalizePostcode(b.postcode) ||
    normalizePostcode(b.postalCode) ||
    normalizePostcode(b.postal_code) ||
    normalizePostcode(b.sortingCode) ||
    "";
  if (!postcode) {
    for (const part of [street1, street2, city, region, b.address3]) {
      postcode = extractUkPostcodeFromText(part);
      if (postcode) break;
    }
  }
  const country = (
    (typeof b.country_code === "string" && b.country_code.trim()) ||
    (typeof b.countryCode === "string" && b.countryCode.trim()) ||
    ""
  )
    .replace(ZERO_WIDTH, "")
    .trim()
    .toUpperCase();
  if (!postcode || !country || country.length !== 2) return null;
  return {
    street_line_1: street1,
    street_line_2: street2,
    city,
    region,
    postcode,
    country_code: country,
  };
}

function mapBrowserEnvironment(raw: unknown): GooglePayBrowserEnvironment | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  if (e.type !== "browser") return null;
  const browserUrl = typeof e.browser_url === "string" ? e.browser_url.trim() : "";
  if (!browserUrl) return null;
  const timeZone = Number(e.time_zone_utc_offset);
  const colorDepth = Number(e.color_depth);
  const screenWidth = Number(e.screen_width);
  const screenHeight = Number(e.screen_height);
  if (
    !Number.isFinite(timeZone) ||
    !Number.isFinite(colorDepth) ||
    !Number.isFinite(screenWidth) ||
    !Number.isFinite(screenHeight) ||
    screenWidth <= 0 ||
    screenHeight <= 0
  ) {
    return null;
  }
  const challenge = Number(e.challenge_window_width);
  const locale = typeof e.locale === "string" ? e.locale.trim() : "";
  return {
    type: "browser",
    time_zone_utc_offset: Math.trunc(timeZone),
    color_depth: Math.trunc(colorDepth),
    screen_width: Math.trunc(screenWidth),
    screen_height: Math.trunc(screenHeight),
    java_enabled: e.java_enabled === true,
    ...(Number.isFinite(challenge) && challenge > 0
      ? { challenge_window_width: Math.trunc(challenge) }
      : {}),
    browser_url: browserUrl,
    ...(locale ? { locale } : {}),
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const clientIP = getClientIP(req);
  const rl = checkRateLimit(clientIP, RATE_LIMIT_CONFIG);
  if (!rl.allowed) return rateLimitResponse(rl);

  try {
    const auth = req.headers.get("Authorization");
    if (!auth) return errorResponse("Missing authorization header", 401, undefined, "AUTH_MISSING");

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { data: { user }, error: authErr } = await supabase.auth.getUser(
      auth.replace("Bearer ", ""),
    );
    if (authErr || !user) {
      return errorResponse("Unauthorized", 401, undefined, "AUTH_INVALID");
    }

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return errorResponse("Invalid JSON body", 400, undefined, "VALIDATION_FAILED");
    }

    const clientActionId =
      typeof body.client_action_id === "string" ? body.client_action_id.trim() : "";
    const providerOrderId =
      typeof body.provider_order_id === "string" ? body.provider_order_id.trim() : "";
    const paymentSessionId =
      typeof body.payment_session_id === "string" ? body.payment_session_id.trim() : "";
    const googlePayToken =
      typeof body.google_pay_token === "string" ? body.google_pay_token.trim() : "";
    const cardholderName =
      typeof body.cardholder_name === "string" ? body.cardholder_name.trim() : "";
    const billingAddress = mapBillingAddress(body.billing_address);
    const browserEnvironment = mapBrowserEnvironment(body.browser_environment);
    const userAgent = req.headers.get("user-agent") || "unknown";

    if (!providerOrderId || !googlePayToken) {
      return errorResponse(
        "provider_order_id and google_pay_token are required",
        400,
        undefined,
        "VALIDATION_MISSING_FIELD",
      );
    }
    if (!clientActionId && !paymentSessionId) {
      return errorResponse(
        "client_action_id or payment_session_id required",
        400,
        undefined,
        "VALIDATION_MISSING_FIELD",
      );
    }
    const resolvedCardholderName = cardholderName || "Cardholder";
    if (!billingAddress) {
      return errorResponse(
        "billing_address with country_code and postcode is required",
        400,
        undefined,
        "VALIDATION_MISSING_FIELD",
      );
    }
    // Older app builds omit browser_environment. Prefer the client CIT payload when
    // present; otherwise use the app ACS URL + request IP/UA (never https://onecab.app).
    const resolvedBrowserEnvironment: GooglePayBrowserEnvironment = browserEnvironment ?? {
      type: "browser",
      time_zone_utc_offset: 0,
      color_depth: 24,
      screen_width: 1080,
      screen_height: 1920,
      java_enabled: false,
      challenge_window_width: 360,
      browser_url: "onecab-customer://payment-acs",
      locale: "en-GB",
    };

    let query = supabase
      .from("payment_sessions")
      .select(
        "id, user_id, status, provider_state, provider_order_id, client_action_id, authorised_amount_pence, metadata",
      )
      .eq("provider_order_id", providerOrderId);

    if (paymentSessionId) query = query.eq("id", paymentSessionId);
    if (clientActionId) query = query.eq("client_action_id", clientActionId);

    const { data: ps, error: psErr } = await query.maybeSingle();
    if (psErr || !ps) {
      return errorResponse("payment_session not found", 404, undefined, "SESSION_NOT_FOUND");
    }
    if (ps.user_id !== user.id) {
      return errorResponse("Forbidden", 403, undefined, "AUTH_INVALID");
    }

    const provState = String(ps.provider_state ?? "").toUpperCase();
    const status = String(ps.status ?? "").toLowerCase();

    // Already authorised / completed — idempotent success without re-submitting token.
    if (
      provState === "AUTHORISED" ||
      provState === "COMPLETED" ||
      status === "authorised_hold" ||
      status === "captured" ||
      status === "trip_created"
    ) {
      return successResponse({
        submitted: true,
        idempotent: true,
        provider_order_id: ps.provider_order_id,
        payment_session_id: ps.id,
        status: ps.status,
        provider_state: ps.provider_state,
      });
    }

    const meta = (ps.metadata && typeof ps.metadata === "object"
      ? ps.metadata
      : {}) as Record<string, unknown>;
    const tokenHash = await sha256Hex(googlePayToken);
    if (
      typeof meta.google_pay_token_sha256 === "string" &&
      meta.google_pay_token_sha256 === tokenHash &&
      meta.google_pay_submitted === true
    ) {
      return successResponse({
        submitted: true,
        idempotent: true,
        provider_order_id: ps.provider_order_id,
        payment_session_id: ps.id,
        status: ps.status,
        provider_state: ps.provider_state,
      });
    }

    // Same vault-first merchant as order creation and confirm/reconcile of this order.
    const { secretKey, environment } = await resolveRevolutMerchantContext(supabase, "live");

    // Soft-check order still payable
    try {
      const existing = await retrieveRevolutOrder(environment, secretKey, providerOrderId);
      const state = String(existing.state ?? "").toUpperCase();
      if (state === "AUTHORISED" || state === "COMPLETED") {
        return successResponse({
          submitted: true,
          idempotent: true,
          provider_order_id: providerOrderId,
          payment_session_id: ps.id,
          status: ps.status,
          provider_state: existing.state,
        });
      }
      if (["CANCELLED", "FAILED", "REFUNDED"].includes(state)) {
        return errorResponse(
          "Order is no longer payable",
          409,
          { provider_state: existing.state },
          "ORDER_NOT_PAYABLE",
        );
      }
    } catch {
      // Continue — pay endpoint will fail clearly if order missing.
    }

    let revolutResult;
    try {
      revolutResult = await payRevolutOrderWithGooglePay({
        environment,
        secretKey,
        orderId: providerOrderId,
        googlePayToken,
        cardholderName: resolvedCardholderName,
        billingAddress,
        browserEnvironment: resolvedBrowserEnvironment,
        clientIp: clientIP,
        userAgent,
      });
    } catch (err) {
      // Read-only GET of the same order for Revolut's decline_reason. Never re-submits.
      let declineReason: string | null = null;
      try {
        const after = await retrieveRevolutOrder(environment, secretKey, providerOrderId);
        declineReason = latestFailedPaymentDeclineReason(after.payments);
      } catch {
        declineReason = null;
      }
      const revolutMessage = revolutFailureMessage(err);
      const revolutStatus =
        err && typeof err === "object" && typeof (err as { status?: unknown }).status === "number"
          ? (err as { status: number }).status
          : null;
      const failure = classifyGooglePaySubmitFailure({
        declineReason,
        providerRejected: false,
        providerHttpStatus: revolutStatus,
      });
      await logAuditEvent(supabase, "GOOGLE_PAY_SUBMIT_FAILED", {
        details: {
          payment_session_id: ps.id,
          provider_order_id: providerOrderId,
          token_sha256: tokenHash,
          message: revolutMessage,
          revolut_http_status: revolutStatus,
          decline_reason: failure.decline_reason,
          failure_code: failure.code,
          response_status: failure.status,
        },
        ipAddress: clientIP,
        userAgent,
      });
      return errorResponse(
        failure.message,
        failure.status,
        { decline_reason: failure.decline_reason, bank_declined: failure.bank_declined },
        failure.code,
      );
    }

    await supabase
      .from("payment_sessions")
      .update({
        provider_state: revolutResult.state ?? ps.provider_state,
        metadata: {
          ...meta,
          google_pay_submitted: true,
          google_pay_token_sha256: tokenHash,
          google_pay_submitted_at: new Date().toISOString(),
        },
        updated_at: new Date().toISOString(),
      })
      .eq("id", ps.id);

    await logAuditEvent(supabase, "GOOGLE_PAY_SUBMITTED", {
      details: {
        payment_session_id: ps.id,
        provider_order_id: providerOrderId,
        token_sha256: tokenHash,
        provider_state: revolutResult.state ?? null,
      },
      ipAddress: clientIP,
      userAgent,
    });

    if (isFailedPaymentState(revolutResult.state)) {
      const failure = classifyGooglePaySubmitFailure({
        declineReason: revolutResult.decline_reason ?? null,
        providerRejected: true,
      });
      return errorResponse(
        failure.message,
        failure.status,
        {
          decline_reason: failure.decline_reason,
          bank_declined: failure.bank_declined,
          provider_state: revolutResult.state ?? null,
        },
        failure.code,
      );
    }

    return successResponse({
      submitted: true,
      idempotent: false,
      provider_order_id: providerOrderId,
      payment_session_id: ps.id,
      status: ps.status,
      provider_state: revolutResult.state ?? null,
    });
  } catch (err) {
    console.error("[submit-revolut-google-pay]", err instanceof Error ? err.message : err);
    return errorResponse("Internal error", 500, undefined, "INTERNAL");
  }
});
