/**
 * setup-revolut-card
 *
 * Merchant-vault Add Card (NOT booking pay):
 *   action=start  → £1 verification order token for native card form
 *                   (SDK savePaymentMethodFor=merchant via saveCardByDefault)
 *                   Reuses resume_provider_order_id when still PENDING/AUTHORISED
 *   action=complete → persist reusable method after SDK success + release hold
 *   action=cancel → void/cancel the £1 setup order (fail / timeout / abandon)
 *
 * No trip id. Dedicated client idempotency_key / setupRef (merchant_order_ext_ref).
 * Ownership: complete/cancel reject when metadata.customer_user_id !== JWT user (ORDER_NOT_FOUND).
 * Dedupe: unique (user_id, provider, provider_pm_id); re-complete returns SAVED_CARD_ALREADY_SAVED.
 * Money: capture_mode=manual, never_capture — £1 is auth-only and cancelled/voided (never revenue).
 * Never returns hosted checkout URLs. Token is for RevolutMerchantCardFormKit only.
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
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
  isReusableSaveCardSetupState,
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

function assertSaveCardOwnership(
  order: { metadata?: Record<string, unknown> | null },
  userId: string,
): boolean {
  const metadata = (order.metadata ?? {}) as Record<string, string>;
  return metadata.purpose === "save_card" && metadata.customer_user_id === userId;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: nativeAppCorsHeaders });
  }

  const clientIP = getClientIP(req);
  const rl = checkRateLimit(clientIP, RATE_LIMIT_CONFIG);
  if (!rl.allowed) return rateLimitResponse(rl);

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

    if (action === "cancel") {
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

      if (!assertSaveCardOwnership(order, user.id)) {
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

      await releaseSaveCardVerificationOrder({
        environment,
        secretKey,
        orderId: providerOrderId,
      });

      edgeStatus = 200;
      safeLog({
        edgeStatus,
        authenticated,
        customerResolved: false,
        providerEnvironment,
        orderCreated: true,
        checkoutTokenReturned: false,
        revolutStatusCode: null,
        code: "OK",
        action,
        voided: true,
      });
      return successResponse({
        success: true,
        voided: true,
        provider_order_id: providerOrderId,
      });
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

      if (!assertSaveCardOwnership(order, user.id)) {
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
      // Prefer AUTHORISED (manual capture, never COMPLETED/captured). PROCESSING allowed while settling.
      if (!["AUTHORISED", "AUTHORIZED", "PROCESSING"].includes(state)) {
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
        .select(
          "provider_payment_method_id, platform_payment_method_id, brand, last4, exp_month, exp_year, tokenization_status",
        )
        .eq("user_id", user.id)
        .eq("payment_provider", "revolut");

      type ExistingTokenRow = {
        provider_payment_method_id: string | null;
        platform_payment_method_id: string | null;
        brand: string | null;
        last4: string | null;
        exp_month: number | null;
        exp_year: number | null;
        tokenization_status: string | null;
      };
      const knownByProviderId = new Map<string, ExistingTokenRow>();
      for (const r of (existingRows ?? []) as ExistingTokenRow[]) {
        const pid = String(r.provider_payment_method_id ?? "").trim();
        if (pid) knownByProviderId.set(pid, r);
      }

      const fresh = cardMethods.filter((m) => !knownByProviderId.has(m.id));

      // Idempotent complete: provider PM already vaulted for this user — no duplicate insert.
      if (fresh.length === 0) {
        await releaseSaveCardVerificationOrder({ environment, secretKey, orderId: providerOrderId });
        const already = cardMethods
          .map((m) => knownByProviderId.get(m.id))
          .find((row) => row && String(row.tokenization_status ?? "") !== "removed");
        if (already?.platform_payment_method_id) {
          edgeStatus = 200;
          safeLog({
            edgeStatus,
            authenticated,
            customerResolved,
            providerEnvironment,
            orderCreated: true,
            checkoutTokenReturned: false,
            revolutStatusCode: null,
            code: "SAVED_CARD_ALREADY_SAVED",
            action,
          });
          return successResponse({
            success: true,
            already_saved: true,
            card: {
              platform_payment_method_id: already.platform_payment_method_id,
              brand: already.brand,
              last4: already.last4,
              exp_month: already.exp_month,
              exp_year: already.exp_year,
            },
          });
        }
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
        // Unique (user_id, payment_provider, provider_payment_method_id) race → return existing.
        const msg = String(insertErr.message ?? "").toLowerCase();
        const isUnique =
          insertErr.code === "23505" ||
          msg.includes("duplicate") ||
          msg.includes("unique");
        if (isUnique) {
          const { data: raced } = await supabase
            .from("customer_saved_payment_method_tokens")
            .select("platform_payment_method_id, brand, last4, exp_month, exp_year")
            .eq("user_id", user.id)
            .eq("payment_provider", "revolut")
            .eq("provider_payment_method_id", method.id)
            .maybeSingle();
          if (raced?.platform_payment_method_id) {
            await releaseSaveCardVerificationOrder({
              environment,
              secretKey,
              orderId: providerOrderId,
            });
            edgeStatus = 200;
            safeLog({
              edgeStatus,
              authenticated,
              customerResolved,
              providerEnvironment,
              orderCreated: true,
              checkoutTokenReturned: false,
              revolutStatusCode: null,
              code: "SAVED_CARD_ALREADY_SAVED",
              action,
            });
            return successResponse({
              success: true,
              already_saved: true,
              card: {
                platform_payment_method_id: raced.platform_payment_method_id,
                brand: raced.brand,
                last4: raced.last4,
                exp_month: raced.exp_month,
                exp_year: raced.exp_year,
              },
            });
          }
        }
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

    // App-kill / duplicate Add Card: reuse one open setup order (no second £1).
    const resumeProviderOrderId =
      typeof body.resume_provider_order_id === "string" && body.resume_provider_order_id.trim()
        ? body.resume_provider_order_id.trim()
        : null;
    if (resumeProviderOrderId) {
      try {
        const existing = await retrieveRevolutOrder(
          environment,
          secretKey,
          resumeProviderOrderId,
        );
        if (assertSaveCardOwnership(existing, user.id)) {
          const existingState = String(existing.state ?? "").toUpperCase();
          const orderToken = existing.token ?? existing.public_id ?? null;
          if (
            isReusableSaveCardSetupState(existingState) &&
            orderToken &&
            existing.id
          ) {
            const metadata = (existing.metadata ?? {}) as Record<string, string>;
            checkoutTokenReturned = true;
            orderCreated = true;
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
              reused: true,
              hasProviderOrderId: true,
            });
            return successResponse({
              success: true,
              reused: true,
              provider_order_id: existing.id,
              order_token: orderToken,
              setup_ref: metadata.setup_ref || setupRef,
            });
          }
          // Stale / terminal — void leftover hold before minting a new setup order.
          await releaseSaveCardVerificationOrder({
            environment,
            secretKey,
            orderId: resumeProviderOrderId,
          });
        }
      } catch (err) {
        const apiErr = err as RevolutApiError;
        revolutStatusCode = typeof apiErr?.status === "number" ? apiErr.status : null;
        safeLog({
          edgeStatus: 200,
          authenticated,
          customerResolved,
          providerEnvironment,
          orderCreated: false,
          checkoutTokenReturned: false,
          revolutStatusCode,
          code: "RESUME_SETUP_MISS",
          action,
          message: "resume miss — creating new setup order",
        });
      }
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
