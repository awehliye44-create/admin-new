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
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
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
  getRevolutMerchantConfig,
  payRevolutOrderWithGooglePay,
  retrieveRevolutOrder,
  type GooglePayBillingAddress,
} from "../_shared/revolutOrders.ts";

const RATE_LIMIT_CONFIG = { limit: 15, windowMs: 60 * 1000 };

async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function mapBillingAddress(raw: unknown): GooglePayBillingAddress | null {
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Record<string, unknown>;
  const street1 =
    (typeof b.street_line_1 === "string" && b.street_line_1) ||
    (typeof b.address1 === "string" && b.address1) ||
    undefined;
  const street2 =
    (typeof b.street_line_2 === "string" && b.street_line_2) ||
    (typeof b.address2 === "string" && b.address2) ||
    undefined;
  const city =
    (typeof b.city === "string" && b.city) ||
    (typeof b.locality === "string" && b.locality) ||
    undefined;
  const region =
    (typeof b.region === "string" && b.region) ||
    (typeof b.administrativeArea === "string" && b.administrativeArea) ||
    undefined;
  const postcode =
    (typeof b.postcode === "string" && b.postcode) ||
    (typeof b.postalCode === "string" && b.postalCode) ||
    undefined;
  const country =
    (typeof b.country_code === "string" && b.country_code) ||
    (typeof b.countryCode === "string" && b.countryCode) ||
    undefined;
  if (!street1 && !city && !postcode && !country) return null;
  return {
    street_line_1: street1,
    street_line_2: street2,
    city,
    region,
    postcode,
    country_code: country,
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const clientIP = getClientIP(req);
  const rl = checkRateLimit(clientIP, RATE_LIMIT_CONFIG);
  if (!rl.allowed) return rateLimitResponse(rl.retryAfter!);

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
      typeof body.cardholder_name === "string" ? body.cardholder_name.trim() : null;

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

    const { secretKey, environment } = getRevolutMerchantConfig();

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
        cardholderName,
        billingAddress: mapBillingAddress(body.billing_address),
      });
    } catch (err) {
      await logAuditEvent(supabase, "GOOGLE_PAY_SUBMIT_FAILED", {
        details: {
          payment_session_id: ps.id,
          provider_order_id: providerOrderId,
          token_sha256: tokenHash,
          message: err instanceof Error ? err.message : "pay_failed",
        },
        ipAddress: clientIP,
        userAgent: req.headers.get("user-agent") || "unknown",
      });
      return errorResponse(
        "Google Pay submission failed",
        502,
        undefined,
        "GOOGLE_PAY_SUBMIT_FAILED",
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
      userAgent: req.headers.get("user-agent") || "unknown",
    });

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
