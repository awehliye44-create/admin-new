import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { resolveConfirmRevolutMaxWaitMs } from "../_shared/confirmRevolutPaymentWaitSSOT.ts";
import { resolveRevolutMerchantContext } from "../_shared/revolutMerchantContext.ts";
import { finalizeRevolutTokenCapture } from "../_shared/revolutSavedCardWalletLink.ts";
import {
  isRevolutAuthorisedState,
  isRevolutInFlightState,
  markRevolutAuthLedgerFailed,
  verifyRevolutOrderConfirmedForBooking,
} from "../_shared/revolutPaymentConfirmation.ts";
import { markPaymentSessionAuthorised, markCardSetupOrphaned } from "../_shared/paymentSessionSSOT.ts";
import { retrieveRevolutOrder } from "../_shared/revolutOrders.ts";
import { serveWithEdgeTiming } from "../_shared/edgeFunctionTiming.ts";

declare const EdgeRuntime: { waitUntil: (promise: Promise<unknown>) => void };

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const FAILED_STATES = new Set(["FAILED", "CANCELLED", "REFUNDED"]);

serveWithEdgeTiming("confirm-revolut-payment", corsHeaders, async (req) => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");

  if (!supabaseAnonKey) {
    return json({ error: "SUPABASE_ANON_KEY not set" }, 500);
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false },
  });

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "Unauthorized" }, 401);

  const anonClient = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const token = authHeader.replace("Bearer ", "");
  const { data: claimsData, error: claimsError } = await anonClient.auth.getClaims(token);
  if (claimsError || !claimsData?.claims) return json({ error: "Unauthorized" }, 401);
  const userId = claimsData.claims.sub as string;

  const body = await req.json().catch(() => ({})) as {
    order_id?: string;
    payment_intent_id?: string;
    client_action_id?: string | null;
    provider_error_message?: string | null;
    provider_error_type?: string | null;
    expect_saved_card_token?: boolean;
    max_wait_ms?: number | null;
  };

  const orderId = String(body.order_id ?? body.payment_intent_id ?? "").trim();
  if (!orderId) return json({ error: "order_id is required" }, 400);

  try {
    const merchant = await resolveRevolutMerchantContext(supabase, "live");

    // Honour client max_wait_ms (Book sends 0 = one retrieve). Cap booking at 2s.
    const wait = resolveConfirmRevolutMaxWaitMs(body);
    const confirmation = await verifyRevolutOrderConfirmedForBooking(
      supabase,
      merchant.environment,
      merchant.secretKey,
      orderId,
      {
        maxWaitMs: wait.maxWaitMs,
        pollIntervalMs: wait.pollIntervalMs,
      },
    );

    if (confirmation.ok) {
      const order = confirmation.order;
      const orderCustomerUserId = order.metadata?.customer_user_id;
      if (orderCustomerUserId && orderCustomerUserId !== userId) {
        return json({ confirmed: false, failed: true, reason: "Payment does not belong to this user" }, 403);
      }
      const orderClientActionId = order.metadata?.client_action_id;
      if (
        body.client_action_id &&
        orderClientActionId &&
        orderClientActionId !== body.client_action_id
      ) {
        return json({ confirmed: false, failed: true, reason: "Payment does not belong to this booking" }, 403);
      }

      const platformPmId = order.metadata?.platform_payment_method_id ?? null;
      const isSaveCardPurpose = order.metadata?.purpose === "save_card";
      const saveCardEligible =
        isSaveCardPurpose
        || order.metadata?.save_card_eligible === "true"
        || body.expect_saved_card_token === true;
      if (saveCardEligible && !platformPmId) {
        console.warn("[confirm-revolut-payment] payment_method.setup_missing_platform_pm", {
          order_id: order.id,
          expect_saved_card_token: body.expect_saved_card_token === true,
          purpose: order.metadata?.purpose ?? null,
        });
      }

      // Booking holds: mark authorised + return immediately. Token capture must not
      // gate Finding (old poll ladder was ~82s). Post-commit / waitUntil finishes save.
      if (!isSaveCardPurpose) {
        await markPaymentSessionAuthorised(supabase, {
          providerOrderId: order.id,
          clientActionId: body.client_action_id ?? order.metadata?.client_action_id ?? null,
        });
        if (saveCardEligible) {
          const captureTask = finalizeRevolutTokenCapture(supabase, {
            environment: merchant.environment,
            secretKey: merchant.secretKey,
            orderId: order.id,
            userId,
            platformPaymentMethodId: platformPmId,
            orderMetadata: order.metadata ?? undefined,
            pollProfile: "booking",
            markFailedOnMiss: false,
          }).then((capture) => {
            if (capture.captured) {
              console.info("[confirm-revolut-payment] payment_method.provider_confirmed_deferred", {
                order_id: order.id,
                token_captured: true,
              });
            } else {
              console.warn("[confirm-revolut-payment] payment_method.capture_deferred_miss", {
                order_id: order.id,
                has_platform_pm: Boolean(platformPmId),
              });
            }
          }).catch((err) => {
            console.warn("[confirm-revolut-payment] payment_method.capture_deferred_error", {
              order_id: order.id,
              error: String(err),
            });
          });
          if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
            EdgeRuntime.waitUntil(captureTask);
          } else {
            void captureTask;
          }
        }
        return json({
          confirmed: true,
          failed: false,
          state: order.state ?? "AUTHORISED",
          confirmed_via: confirmation.confirmed_via,
          order_id: order.id,
          token_captured: false,
          token_capture_deferred: saveCardEligible,
          tokenization_failed: false,
          provider_reference: null,
          platform_payment_method_id: platformPmId,
        });
      }

      const capture = await finalizeRevolutTokenCapture(supabase, {
        environment: merchant.environment,
        secretKey: merchant.secretKey,
        orderId: order.id,
        userId,
        platformPaymentMethodId: platformPmId,
        orderMetadata: order.metadata ?? undefined,
        pollProfile: "setup",
        markFailedOnMiss: body.expect_saved_card_token === true
          && Boolean(platformPmId),
      });
      if (capture.captured) {
        console.info("[confirm-revolut-payment] payment_method.provider_confirmed", {
          order_id: order.id,
          token_captured: true,
          platform_pm_suffix: capture.platformPaymentMethodId
            ? String(capture.platformPaymentMethodId).slice(-8)
            : null,
        });
      } else if (saveCardEligible) {
        console.warn("[confirm-revolut-payment] payment_method.capture_missed", {
          order_id: order.id,
          has_platform_pm: Boolean(platformPmId),
          tokenization_failed: capture.tokenizationFailed === true,
        });
      }

      await markPaymentSessionAuthorised(supabase, {
        providerOrderId: order.id,
        clientActionId: body.client_action_id ?? order.metadata?.client_action_id ?? null,
      });

      if (
        body.expect_saved_card_token === true
        && (capture.tokenizationFailed || !capture.captured)
      ) {
        await markCardSetupOrphaned(supabase, {
          providerOrderId: order.id,
          userId,
          clientActionId: body.client_action_id ?? order.metadata?.client_action_id ?? null,
          serviceAreaId: order.metadata?.service_area_id ?? null,
          failureReason: capture.tokenizationFailed
            ? "revolut_tokenization_failed"
            : "provider_token_not_persisted",
        });
      }

      return json({
        confirmed: true,
        failed: false,
        state: order.state ?? "AUTHORISED",
        confirmed_via: confirmation.confirmed_via,
        order_id: order.id,
        token_captured: capture.captured,
        tokenization_failed: capture.tokenizationFailed === true,
        provider_reference: capture.providerPaymentMethodId ?? null,
        platform_payment_method_id: capture.platformPaymentMethodId ?? platformPmId,
      });
    }

    const order = confirmation.order;
    const state = String(order?.state ?? "unknown").toUpperCase();

    if (isRevolutInFlightState(state) || state === "PENDING") {
      return json({
        confirmed: false,
        failed: false,
        in_flight: true,
        state,
        reason: confirmation.reason,
      });
    }

    if (FAILED_STATES.has(state)) {
      await markRevolutAuthLedgerFailed(supabase, {
        orderId,
        clientActionId: body.client_action_id,
        orderState: state,
        providerErrorMessage: body.provider_error_message ?? confirmation.reason,
        providerErrorType: body.provider_error_type,
        source: "confirm-revolut-payment",
      });
      console.info("[confirm-revolut-payment] REVOLUT_PAYMENT_DECLINED", {
        orderId,
        state,
        provider_error_type: body.provider_error_type ?? null,
        provider_error_message: body.provider_error_message ?? confirmation.reason ?? null,
      });
      return json({
        confirmed: false,
        failed: true,
        state,
        reason: confirmation.reason ?? `Payment not authorized. Status: ${state}`,
      });
    }

    // Last-chance API read — webhook may lag behind Revolut UI success screen.
    const fresh = await retrieveRevolutOrder(merchant.environment, merchant.secretKey, orderId).catch(() => null);
    const freshState = String(fresh?.state ?? state).toUpperCase();
    if (isRevolutAuthorisedState(freshState)) {
      const platformPmId = fresh?.metadata?.platform_payment_method_id ?? null;
      const isSaveCardPurpose = fresh?.metadata?.purpose === "save_card";
      const capture = fresh?.metadata
        ? await finalizeRevolutTokenCapture(supabase, {
          environment: merchant.environment,
          secretKey: merchant.secretKey,
          orderId,
          userId,
          platformPaymentMethodId: platformPmId,
          orderMetadata: fresh.metadata,
          markFailedOnMiss: isSaveCardPurpose
            && body.expect_saved_card_token === true
            && Boolean(platformPmId),
        })
        : { captured: false };
      await markPaymentSessionAuthorised(supabase, {
        providerOrderId: orderId,
        clientActionId: body.client_action_id ?? fresh?.metadata?.client_action_id ?? null,
      });
      return json({
        confirmed: true,
        failed: false,
        state: freshState,
        confirmed_via: "api",
        order_id: orderId,
        token_captured: capture.captured,
        tokenization_failed: capture.tokenizationFailed === true,
        provider_reference: capture.providerPaymentMethodId ?? null,
        platform_payment_method_id: capture.platformPaymentMethodId ?? platformPmId,
      });
    }

    return json({
      confirmed: false,
      failed: FAILED_STATES.has(freshState),
      in_flight: isRevolutInFlightState(freshState) || freshState === "PENDING",
      state: freshState,
      reason: confirmation.reason ?? `Payment not authorized. Status: ${freshState}`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[confirm-revolut-payment] error", { orderId, message });
    return json({ confirmed: false, failed: false, in_flight: true, reason: message }, 503);
  }
});

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
