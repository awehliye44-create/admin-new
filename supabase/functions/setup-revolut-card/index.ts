/**
 * setup-revolut-card
 *
 * action=start  → verification order token for native card form (save for customer)
 * action=complete → persist saved card after SDK success + release verification hold
 *
 * Never returns hosted checkout URLs. Token is for native RevolutMerchantCardFormKit only.
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  checkRateLimit,
  getClientIP,
  jsonHeaders,
  nativeAppCorsHeaders,
  rateLimitResponse,
  successResponse,
} from "../_shared/security.ts";
import { REVOLUT_SAVE_CARD_TOKENIZATION_READY } from "../_shared/paymentMethodSSOT.ts";
import { getRevolutMerchantConfigFromVault, retrieveRevolutOrder } from "../_shared/revolutOrders.ts";
import type { RevolutApiError } from "../_shared/revolutApi.ts";
import type { ProviderEnvironment } from "../_shared/paymentProviders/types.ts";
import {
  countSavedRevolutCards,
  createRevolutSaveCardSetupOrder,
  ensureRevolutCustomer,
  listRevolutCustomerPaymentMethods,
  mapRevolutPaymentMethodToSavedCardRow,
  MAX_SAVED_REVOLUT_CARDS,
  releaseSaveCardVerificationOrder,
} from "../_shared/revolutSavedCardVault.ts";

const RATE_LIMIT_CONFIG = { limit: 20, windowMs: 60 * 1000 };
const CUSTOMER_SAFE_SETUP_MESSAGE = "Unable to start card setup. Please try again.";

function errorJson(
  code: string,
  status: number,
  customerMessage = CUSTOMER_SAFE_SETUP_MESSAGE,
): Response {
  return new Response(
    JSON.stringify({
      error: code,
      code,
      message: customerMessage,
    }),
    { status, headers: jsonHeaders },
  );
}

function safeLog(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ fn: "setup-revolut-card", ...fields }));
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: nativeAppCorsHeaders });
  }

  const clientIP = getClientIP(req);
  const rl = checkRateLimit(clientIP, RATE_LIMIT_CONFIG);
  if (!rl.allowed) return rateLimitResponse(rl.retryAfter!);

  let authenticated = false;
  let customerResolved = false;
  let providerEnvironment: string | null = null;
  let orderCreated = false;
  let checkoutTokenReturned = false;
  let revolutStatusCode: number | null = null;
  let edgeStatus = 500;
  let action = "start";

  try {
    if (!REVOLUT_SAVE_CARD_TOKENIZATION_READY) {
      edgeStatus = 503;
      safeLog({
        edgeStatus,
        authenticated: false,
        customerResolved: false,
        providerEnvironment: null,
        orderCreated: false,
        checkoutTokenReturned: false,
        revolutStatusCode: null,
        code: "REVOLUT_SAVED_CARD_NOT_IMPLEMENTED",
      });
      return errorJson("REVOLUT_SAVED_CARD_NOT_IMPLEMENTED", 503);
    }

    const auth = req.headers.get("Authorization");
    if (!auth?.startsWith("Bearer ")) {
      edgeStatus = 401;
      safeLog({
        edgeStatus,
        authenticated: false,
        customerResolved: false,
        providerEnvironment: null,
        orderCreated: false,
        checkoutTokenReturned: false,
        revolutStatusCode: null,
        code: "AUTH_MISSING",
      });
      return errorJson("AUTH_MISSING", 401);
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { data: { user }, error: authErr } = await supabase.auth.getUser(
      auth.replace("Bearer ", ""),
    );
    if (authErr || !user) {
      edgeStatus = 401;
      safeLog({
        edgeStatus,
        authenticated: false,
        customerResolved: false,
        providerEnvironment: null,
        orderCreated: false,
        checkoutTokenReturned: false,
        revolutStatusCode: null,
        code: "AUTH_INVALID",
      });
      return errorJson("AUTH_INVALID", 401);
    }
    authenticated = true;

    const body = await req.json().catch(() => ({}));
    action = typeof body.action === "string" ? body.action.trim().toLowerCase() : "start";

    let secretKey: string;
    let environment: ProviderEnvironment;
    try {
      const merchant = await getRevolutMerchantConfigFromVault(supabase);
      secretKey = merchant.secretKey;
      environment = merchant.environment;
      providerEnvironment = environment;
    } catch (err) {
      edgeStatus = 503;
      safeLog({
        edgeStatus,
        authenticated,
        customerResolved: false,
        providerEnvironment: null,
        orderCreated: false,
        checkoutTokenReturned: false,
        revolutStatusCode: null,
        code: "PAYMENT_GATEWAY_NOT_CONFIGURED",
        action,
        message: err instanceof Error ? err.message.slice(0, 120) : "merchant_config",
      });
      return errorJson("PAYMENT_GATEWAY_NOT_CONFIGURED", 503);
    }

    if (action === "complete") {
      const providerOrderId =
        typeof body.provider_order_id === "string" ? body.provider_order_id.trim() : "";
      if (!providerOrderId) {
        edgeStatus = 400;
        safeLog({
          edgeStatus,
          authenticated,
          customerResolved: false,
          providerEnvironment,
          orderCreated: false,
          checkoutTokenReturned: false,
          revolutStatusCode: null,
          code: "VALIDATION_MISSING_FIELD",
          action,
        });
        return errorJson("VALIDATION_MISSING_FIELD", 400);
      }

      let order;
      try {
        order = await retrieveRevolutOrder(environment, secretKey, providerOrderId);
      } catch (err) {
        const apiErr = err as RevolutApiError;
        revolutStatusCode = typeof apiErr?.status === "number" ? apiErr.status : null;
        edgeStatus = revolutStatusCode && revolutStatusCode >= 400 && revolutStatusCode < 600
          ? 502
          : 500;
        safeLog({
          edgeStatus,
          authenticated,
          customerResolved: false,
          providerEnvironment,
          orderCreated: false,
          checkoutTokenReturned: false,
          revolutStatusCode,
          code: "REVOLUT_ORDER_RETRIEVE_FAILED",
          action,
        });
        return errorJson("REVOLUT_ORDER_RETRIEVE_FAILED", edgeStatus);
      }

      const metadata = (order.metadata ?? {}) as Record<string, string>;
      if (metadata.purpose !== "save_card" || metadata.customer_user_id !== user.id) {
        edgeStatus = 404;
        safeLog({
          edgeStatus,
          authenticated,
          customerResolved: false,
          providerEnvironment,
          orderCreated: false,
          checkoutTokenReturned: false,
          revolutStatusCode: null,
          code: "ORDER_NOT_FOUND",
          action,
        });
        return errorJson("ORDER_NOT_FOUND", 404);
      }

      const state = String(order.state ?? "").toUpperCase();
      if (!["AUTHORISED", "COMPLETED", "PROCESSING"].includes(state)) {
        edgeStatus = 409;
        safeLog({
          edgeStatus,
          authenticated,
          customerResolved: false,
          providerEnvironment,
          orderCreated: true,
          checkoutTokenReturned: false,
          revolutStatusCode: null,
          code: "ORDER_NOT_READY",
          action,
          orderState: state,
        });
        return errorJson("ORDER_NOT_READY", 409);
      }

      const email = user.email;
      if (!email) {
        edgeStatus = 400;
        safeLog({
          edgeStatus,
          authenticated,
          customerResolved: false,
          providerEnvironment,
          orderCreated: true,
          checkoutTokenReturned: false,
          revolutStatusCode: null,
          code: "EMAIL_REQUIRED",
          action,
        });
        return errorJson("EMAIL_REQUIRED", 400);
      }

      const { revolutCustomerId } = await ensureRevolutCustomer({
        supabase,
        environment,
        secretKey,
        userId: user.id,
        email,
      });
      customerResolved = true;

      const remoteMethods = await listRevolutCustomerPaymentMethods({
        environment,
        secretKey,
        revolutCustomerId,
      });
      const cardMethods = remoteMethods.filter((m) => m.type === "card" && m.id);

      const { data: existingRows } = await supabase
        .from("customer_saved_payment_method_tokens")
        .select("provider_payment_method_id")
        .eq("user_id", user.id)
        .eq("payment_provider", "revolut");

      const knownIds = new Set(
        (existingRows ?? []).map((r) => String(r.provider_payment_method_id)),
      );
      const fresh = cardMethods.filter((m) => !knownIds.has(m.id));

      if (fresh.length === 0) {
        await releaseSaveCardVerificationOrder({ environment, secretKey, orderId: providerOrderId });
        edgeStatus = 409;
        safeLog({
          edgeStatus,
          authenticated,
          customerResolved,
          providerEnvironment,
          orderCreated: true,
          checkoutTokenReturned: false,
          revolutStatusCode: null,
          code: "SAVED_CARD_NOT_FOUND",
          action,
        });
        return errorJson("SAVED_CARD_NOT_FOUND", 409);
      }

      const savedCount = await countSavedRevolutCards(supabase, user.id);
      if (savedCount >= MAX_SAVED_REVOLUT_CARDS) {
        await releaseSaveCardVerificationOrder({ environment, secretKey, orderId: providerOrderId });
        edgeStatus = 409;
        safeLog({
          edgeStatus,
          authenticated,
          customerResolved,
          providerEnvironment,
          orderCreated: true,
          checkoutTokenReturned: false,
          revolutStatusCode: null,
          code: "SAVED_CARD_LIMIT_REACHED",
          action,
        });
        return errorJson("SAVED_CARD_LIMIT_REACHED", 409);
      }

      const method = fresh[0];
      const platformPaymentMethodId = crypto.randomUUID();
      const insertRow = mapRevolutPaymentMethodToSavedCardRow({
        userId: user.id,
        platformPaymentMethodId,
        method,
      });

      const { error: insertErr } = await supabase
        .from("customer_saved_payment_method_tokens")
        .insert(insertRow);
      if (insertErr) {
        edgeStatus = 500;
        safeLog({
          edgeStatus,
          authenticated,
          customerResolved,
          providerEnvironment,
          orderCreated: true,
          checkoutTokenReturned: false,
          revolutStatusCode: null,
          code: "DB_ERROR",
          action,
        });
        return errorJson("DB_ERROR", 500);
      }

      await releaseSaveCardVerificationOrder({ environment, secretKey, orderId: providerOrderId });

      edgeStatus = 200;
      safeLog({
        edgeStatus,
        authenticated,
        customerResolved,
        providerEnvironment,
        orderCreated: true,
        checkoutTokenReturned: false,
        revolutStatusCode: null,
        code: "OK",
        action,
      });

      return successResponse({
        success: true,
        card: {
          platform_payment_method_id: platformPaymentMethodId,
          brand: insertRow.brand,
          last4: insertRow.last4,
          exp_month: insertRow.exp_month,
          exp_year: insertRow.exp_year,
        },
      });
    }

    // ---- action=start ----
    const savedCount = await countSavedRevolutCards(supabase, user.id);
    if (savedCount >= MAX_SAVED_REVOLUT_CARDS) {
      edgeStatus = 409;
      safeLog({
        edgeStatus,
        authenticated,
        customerResolved: false,
        providerEnvironment,
        orderCreated: false,
        checkoutTokenReturned: false,
        revolutStatusCode: null,
        code: "SAVED_CARD_LIMIT_REACHED",
        action,
      });
      return errorJson("SAVED_CARD_LIMIT_REACHED", 409);
    }

    const email = user.email;
    if (!email) {
      edgeStatus = 400;
      safeLog({
        edgeStatus,
        authenticated,
        customerResolved: false,
        providerEnvironment,
        orderCreated: false,
        checkoutTokenReturned: false,
        revolutStatusCode: null,
        code: "EMAIL_REQUIRED",
        action,
      });
      return errorJson("EMAIL_REQUIRED", 400);
    }

    const currency =
      typeof body.currency === "string" && body.currency.trim()
        ? body.currency.trim().toUpperCase()
        : "GBP";

    // Optional client idempotency key (never logged as a secret).
    const clientIdempotencyKey =
      typeof body.idempotency_key === "string" && body.idempotency_key.trim()
        ? body.idempotency_key.trim().slice(0, 64)
        : typeof body.client_action_id === "string" && body.client_action_id.trim()
          ? body.client_action_id.trim().slice(0, 64)
          : null;
    const setupRef = clientIdempotencyKey || crypto.randomUUID();

    let revolutCustomerId: string;
    try {
      const ensured = await ensureRevolutCustomer({
        supabase,
        environment,
        secretKey,
        userId: user.id,
        email,
      });
      revolutCustomerId = ensured.revolutCustomerId;
      customerResolved = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === "CUSTOMER_PROFILE_NOT_FOUND") {
        edgeStatus = 404;
        safeLog({
          edgeStatus,
          authenticated,
          customerResolved: false,
          providerEnvironment,
          orderCreated: false,
          checkoutTokenReturned: false,
          revolutStatusCode: null,
          code: "CUSTOMER_NOT_FOUND",
          action,
        });
        return errorJson("CUSTOMER_NOT_FOUND", 404);
      }
      const apiErr = err as RevolutApiError;
      revolutStatusCode = typeof apiErr?.status === "number" ? apiErr.status : null;
      edgeStatus = 502;
      safeLog({
        edgeStatus,
        authenticated,
        customerResolved: false,
        providerEnvironment,
        orderCreated: false,
        checkoutTokenReturned: false,
        revolutStatusCode,
        code: "REVOLUT_CUSTOMER_FAILED",
        action,
      });
      return errorJson("REVOLUT_CUSTOMER_FAILED", 502);
    }

    let order;
    try {
      order = await createRevolutSaveCardSetupOrder({
        environment,
        secretKey,
        currency,
        revolutCustomerId,
        customerEmail: email,
        customerUserId: user.id,
        setupRef,
      });
      orderCreated = true;
    } catch (err) {
      const apiErr = err as RevolutApiError;
      revolutStatusCode = typeof apiErr?.status === "number" ? apiErr.status : null;
      edgeStatus = 502;
      safeLog({
        edgeStatus,
        authenticated,
        customerResolved,
        providerEnvironment,
        orderCreated: false,
        checkoutTokenReturned: false,
        revolutStatusCode,
        code: "REVOLUT_ORDER_CREATE_FAILED",
        action,
      });
      return errorJson("REVOLUT_ORDER_CREATE_FAILED", 502);
    }

    const orderToken = order.token ?? order.public_id ?? null;
    if (!orderToken || !order.id) {
      edgeStatus = 502;
      safeLog({
        edgeStatus,
        authenticated,
        customerResolved,
        providerEnvironment,
        orderCreated,
        checkoutTokenReturned: false,
        revolutStatusCode: null,
        code: "ORDER_TOKEN_MISSING",
        action,
        hasOrderId: Boolean(order.id),
      });
      return errorJson("ORDER_TOKEN_MISSING", 502);
    }

    checkoutTokenReturned = true;
    edgeStatus = 200;
    safeLog({
      edgeStatus,
      authenticated,
      customerResolved,
      providerEnvironment,
      orderCreated,
      checkoutTokenReturned,
      revolutStatusCode: null,
      code: "OK",
      action,
      hasProviderOrderId: true,
    });

    return successResponse({
      success: true,
      provider_order_id: order.id,
      order_token: orderToken,
      setup_ref: setupRef,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const apiErr = err as RevolutApiError;
    revolutStatusCode = typeof apiErr?.status === "number" ? apiErr.status : null;
    if (message === "CUSTOMER_PROFILE_NOT_FOUND") {
      edgeStatus = 404;
      safeLog({
        edgeStatus,
        authenticated,
        customerResolved,
        providerEnvironment,
        orderCreated,
        checkoutTokenReturned,
        revolutStatusCode,
        code: "CUSTOMER_NOT_FOUND",
        action,
      });
      return errorJson("CUSTOMER_NOT_FOUND", 404);
    }
    if (message.includes("REVOLUT_MERCHANT_SECRET_KEY") || message.includes("secret key")) {
      edgeStatus = 503;
      safeLog({
        edgeStatus,
        authenticated,
        customerResolved,
        providerEnvironment,
        orderCreated,
        checkoutTokenReturned,
        revolutStatusCode,
        code: "PAYMENT_GATEWAY_NOT_CONFIGURED",
        action,
      });
      return errorJson("PAYMENT_GATEWAY_NOT_CONFIGURED", 503);
    }
    edgeStatus = 500;
    safeLog({
      edgeStatus,
      authenticated,
      customerResolved,
      providerEnvironment,
      orderCreated,
      checkoutTokenReturned,
      revolutStatusCode,
      code: "INTERNAL",
      action,
    });
    return errorJson("INTERNAL", 500);
  }
});
