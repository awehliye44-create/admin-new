/**
 * submit-revolut-google-pay
 *
 * Customer JWT → submit encrypted Google Pay token to Revolut Pay-for-order.
 * Does NOT treat submission as authorised — revolut-webhook / confirm-revolut-payment
 * remain authoritative for authorised_hold.
 *
 * Never logs the raw Google Pay token / PAN / full billing address.
 * Bug #37 — structured Revolut errors, billing contract, no placeholder postcodes.
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
  inspectGooglePayPostcodeShape,
  inspectGooglePayTokenShape,
  payRevolutOrderWithGooglePay,
  retrieveRevolutOrder,
} from "../_shared/revolutOrders.ts";
import { resolveRevolutMerchantContext } from "../_shared/revolutMerchantContext.ts";
import { resolveGooglePayBillingContract } from "./lib/googlePayBillingContract.ts";
import { GOOGLE_PAY_EDGE_DEPLOY_FINGERPRINT } from "./lib/googlePayDeployFingerprint.ts";
import {
  googlePayFailureFingerprint,
  upsertGooglePayOpsAlert,
} from "./lib/googlePayOpsAlertSSOT.ts";

// Keep fingerprint referenced so the Edge bundle always embeds it for deploy gate.
void GOOGLE_PAY_EDGE_DEPLOY_FINGERPRINT;
import {
  classifyGooglePaySubmitFailure,
  classifyMisleadingRevolutPostcodeEmpty,
  isFailedPaymentState,
  latestFailedPaymentDeclineReason,
  readRevolutApiThrow,
  type GooglePaySubmitFailure,
} from "./lib/googlePaySubmitOutcome.ts";

const RATE_LIMIT_CONFIG = { limit: 15, windowMs: 60 * 1000 };

async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function markSessionDefinitiveFailure(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  ps: { id: string; metadata: Record<string, unknown> },
  failure: GooglePaySubmitFailure,
): Promise<void> {
  if (failure.ambiguous) return;
  try {
    const { error } = await supabase
      .from("payment_sessions")
      .update({
        status: "failed",
        provider_state: "FAILED",
        failure_reason: failure.code,
        metadata: {
          ...ps.metadata,
          google_pay_failure_code: failure.code,
          google_pay_failure_category: failure.category,
          google_pay_failure_at: new Date().toISOString(),
          mutation_source: "submit_revolut_google_pay",
        },
        updated_at: new Date().toISOString(),
      })
      .eq("id", ps.id)
      .is("trip_id", null)
      .in("status", ["pending_payment", "processing", "checkout_open", "created", "failed"]);
    if (error) {
      console.error("[submit-revolut-google-pay] markSessionDefinitiveFailure failed", {
        payment_session_id: ps.id,
        message: error.message,
      });
    }
  } catch (err) {
    console.error("[submit-revolut-google-pay] markSessionDefinitiveFailure threw", {
      payment_session_id: ps.id,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const clientIP = getClientIP(req);
  const rl = checkRateLimit(clientIP, RATE_LIMIT_CONFIG);
  if (!rl.allowed) return rateLimitResponse(rl);
  const correlationId = req.headers.get("x-request-id")?.trim() || crypto.randomUUID();

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

    const { secretKey, environment } = await resolveRevolutMerchantContext(supabase, "live");

    const billingContract = resolveGooglePayBillingContract(
      body.billing_address && typeof body.billing_address === "object"
        ? (body.billing_address as Record<string, unknown>)
        : null,
    );
    if (!billingContract.ok) {
      const failure: GooglePaySubmitFailure = {
        status: 400,
        code: "GOOGLE_PAY_BILLING_INCOMPLETE",
        message:
          "Google Pay billing address is incomplete. Choose another payment method or update the card address in Google Wallet.",
        decline_reason: null,
        bank_declined: false,
        category: "billing_incomplete",
        ambiguous: false,
        revolut_error_code: billingContract.code,
        revolut_message: billingContract.code,
        payment_stage: "billing_contract",
      };
      await logAuditEvent(supabase, "GOOGLE_PAY_SUBMIT_FAILED", {
        details: {
          payment_session_id: ps.id,
          provider_order_id: providerOrderId,
          token_sha256: tokenHash,
          message: billingContract.code,
          revolut_http_status: 400,
          revolut_error_code: billingContract.code,
          decline_reason: null,
          customer_code: failure.code,
          category: failure.category,
          payment_stage: failure.payment_stage,
          field_presence: billingContract.field_presence,
          missing_fields: billingContract.missing_fields,
          correlation_id: correlationId,
          ambiguous: false,
        },
        ipAddress: clientIP,
        userAgent: req.headers.get("user-agent") || "unknown",
      });
      await markSessionDefinitiveFailure(supabase, { id: ps.id, metadata: meta }, failure);
      await upsertGooglePayOpsAlert(supabase, {
        fingerprint: googlePayFailureFingerprint({
          customer_code: failure.code,
          revolut_error_code: billingContract.code,
        }),
        title: "Google Pay billing incomplete",
        description:
          "Wallet did not supply a usable billing postcode. Submit blocked before Revolut Pay-for-order.",
        severity: "warning",
        related_payment_session_id: ps.id,
        metadata: {
          category: failure.category,
          field_presence: billingContract.field_presence,
          correlation_id: correlationId,
        },
      });
      return errorResponse(
        failure.message,
        failure.status,
        {
          missing_fields: billingContract.missing_fields,
          field_presence: billingContract.field_presence,
          category: failure.category,
          correlation_id: correlationId,
        },
        failure.code,
      );
    }

    const billingAddress = billingContract.billing;
    const tokenShape = inspectGooglePayTokenShape(googlePayToken);
    const postcodeShape = inspectGooglePayPostcodeShape(billingAddress.postcode);
    if (tokenShape.token_looks_truncated || !tokenShape.token_is_json_object) {
      const failure: GooglePaySubmitFailure = {
        status: 400,
        code: "GOOGLE_PAY_SUBMIT_FAILED",
        message:
          "Google Pay could not authorise this card. Update the card address in Google Wallet or choose another payment method.",
        decline_reason: null,
        bank_declined: false,
        category: "validation",
        ambiguous: false,
        revolut_error_code: "google_pay_token_invalid",
        revolut_message: "google_pay_token is invalid",
        payment_stage: "token_integrity",
      };
      await logAuditEvent(supabase, "GOOGLE_PAY_SUBMIT_FAILED", {
        details: {
          payment_session_id: ps.id,
          provider_order_id: providerOrderId,
          token_sha256: tokenHash,
          message: failure.revolut_message,
          revolut_http_status: 400,
          revolut_error_code: failure.revolut_error_code,
          customer_code: failure.code,
          category: failure.category,
          payment_stage: failure.payment_stage,
          field_presence: billingContract.field_presence,
          ...tokenShape,
          ...postcodeShape,
          correlation_id: correlationId,
          ambiguous: false,
        },
        ipAddress: clientIP,
        userAgent: req.headers.get("user-agent") || "unknown",
      });
      await markSessionDefinitiveFailure(supabase, { id: ps.id, metadata: meta }, failure);
      return errorResponse(failure.message, failure.status, {
        category: failure.category,
        correlation_id: correlationId,
        ...tokenShape,
      }, failure.code);
    }

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
          { provider_state: existing.state, correlation_id: correlationId },
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
        billingAddress,
        browserEnvironment: {
          client_ip: clientIP,
          user_agent: req.headers.get("user-agent"),
        },
      });
    } catch (err) {
      const revolutThrow = readRevolutApiThrow(err);
      let declineReason: string | null = null;
      let authRequired = false;
      try {
        const after = await retrieveRevolutOrder(environment, secretKey, providerOrderId);
        declineReason = latestFailedPaymentDeclineReason(after.payments);
        const payments = Array.isArray(after.payments) ? after.payments : [];
        authRequired = payments.some((p) => {
          const challenge = (p as { authentication_challenge?: unknown })
            ?.authentication_challenge;
          return Boolean(challenge);
        });
      } catch {
        declineReason = null;
      }
      // Revolut returns "postcode is empty" for invalid tokens even when Wallet
      // billing postcode was present — do not blame Wallet address (Bug #37).
      const misleadingPostcode = classifyMisleadingRevolutPostcodeEmpty({
        billingPostcodePresent: billingContract.field_presence.postcode === true,
        revolutMessage: revolutThrow.message,
        revolutErrorCode: revolutThrow.revolut_error_code,
        revolutHttpStatus: revolutThrow.status,
        paymentStage: "pay_for_order",
      });
      const failure = misleadingPostcode ??
        classifyGooglePaySubmitFailure({
          declineReason,
          providerRejected: false,
          revolutHttpStatus: revolutThrow.status,
          revolutMessage: revolutThrow.message,
          revolutErrorCode: revolutThrow.revolut_error_code,
          paymentStage: "pay_for_order",
          authenticationRequired: authRequired,
        });
      await logAuditEvent(supabase, "GOOGLE_PAY_SUBMIT_FAILED", {
        details: {
          payment_session_id: ps.id,
          provider_order_id: providerOrderId,
          token_sha256: tokenHash,
          message: revolutThrow.message,
          revolut_http_status: revolutThrow.status,
          revolut_error_code: revolutThrow.revolut_error_code,
          decline_reason: failure.decline_reason,
          customer_code: failure.code,
          category: failure.category,
          payment_stage: failure.payment_stage,
          field_presence: billingContract.field_presence,
          postcode_paradox: Boolean(misleadingPostcode),
          revolut_postcode_empty_means_token_rejected: Boolean(misleadingPostcode),
          ...tokenShape,
          ...postcodeShape,
          correlation_id: correlationId,
          ambiguous: failure.ambiguous,
        },
        ipAddress: clientIP,
        userAgent: req.headers.get("user-agent") || "unknown",
      });
      await markSessionDefinitiveFailure(supabase, { id: ps.id, metadata: meta }, failure);
      await upsertGooglePayOpsAlert(supabase, {
        fingerprint: googlePayFailureFingerprint({
          customer_code: failure.code,
          revolut_error_code: revolutThrow.revolut_error_code,
        }),
        title: `Google Pay submit ${failure.category}`,
        description: `Sanitised provider message: ${revolutThrow.message}`.slice(0, 280),
        severity: failure.ambiguous ? "warning" : "critical",
        related_payment_session_id: ps.id,
        metadata: {
          category: failure.category,
          revolut_http_status: revolutThrow.status,
          correlation_id: correlationId,
          ambiguous: failure.ambiguous,
        },
      });
      return errorResponse(
        failure.message,
        failure.status,
        {
          decline_reason: failure.decline_reason,
          bank_declined: failure.bank_declined,
          revolut_message: revolutThrow.message,
          revolut_http_status: revolutThrow.status,
          revolut_error_code: revolutThrow.revolut_error_code,
          category: failure.category,
          ambiguous: failure.ambiguous,
          correlation_id: correlationId,
        },
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
          google_pay_billing_field_presence: billingContract.field_presence,
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
        field_presence: billingContract.field_presence,
        correlation_id: correlationId,
        payment_stage: "pay_for_order",
      },
      ipAddress: clientIP,
      userAgent: req.headers.get("user-agent") || "unknown",
    });

    if (isFailedPaymentState(revolutResult.state)) {
      const failure = classifyGooglePaySubmitFailure({
        declineReason: revolutResult.decline_reason ?? null,
        providerRejected: true,
        revolutMessage: revolutResult.decline_reason ?? null,
        paymentStage: "provider_payment_state",
      });
      await markSessionDefinitiveFailure(supabase, { id: ps.id, metadata: meta }, failure);
      return errorResponse(
        failure.message,
        failure.status,
        {
          decline_reason: failure.decline_reason,
          bank_declined: failure.bank_declined,
          provider_state: revolutResult.state ?? null,
          category: failure.category,
          correlation_id: correlationId,
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
      correlation_id: correlationId,
    });
  } catch (err) {
    console.error("[submit-revolut-google-pay]", err instanceof Error ? err.message : err);
    return errorResponse("Internal error", 500, { correlation_id: correlationId }, "INTERNAL");
  }
});
