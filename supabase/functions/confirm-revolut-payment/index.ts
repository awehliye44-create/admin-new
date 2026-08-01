import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import Stripe from "npm:stripe@18.5.0";
import { resolveRevolutMerchantContext } from "../_shared/revolutMerchantContext.ts";
import { finalizeRevolutTokenCapture } from "../_shared/revolutSavedCardWalletLink.ts";
import {
  isRevolutAuthorisedState,
  isRevolutInFlightState,
  markRevolutAuthLedgerFailed,
  verifyRevolutOrderConfirmedForBooking,
} from "../_shared/revolutPaymentConfirmation.ts";
import { markPaymentSessionAuthorised, markCardSetupOrphaned, recordPaymentSessionSaveCardConsent } from "../_shared/paymentSessionSSOT.ts";
import { retrieveRevolutOrder } from "../_shared/revolutOrders.ts";
import { serveWithEdgeTiming } from "../_shared/edgeFunctionTiming.ts";

declare const EdgeRuntime: { waitUntil: (promise: Promise<unknown>) => void };

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const FAILED_STATES = new Set(["FAILED", "CANCELLED", "REFUNDED"]);

function scheduleBackgroundTokenCapture(task: () => Promise<unknown>): void {
  const run = task().catch((err) => {
    console.warn("[confirm-revolut-payment] background token capture failed", String(err));
  });
  try {
    if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
      EdgeRuntime.waitUntil(run);
      return;
    }
  } catch {
    /* fall through */
  }
  // Best-effort when waitUntil is unavailable — do not await on the booking path.
  void run;
}

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
    /** Exact Revolut checkout checkbox consent (customer may untick). */
    save_card_requested?: boolean | null;
    save_card_consent_at?: string | null;
    /** Client-requested server poll budget (ms). 0 = single Merchant retrieve. */
    max_wait_ms?: number;
  };

  const orderId = String(body.order_id ?? body.payment_intent_id ?? "").trim();
  if (!orderId) return json({ error: "order_id is required" }, 400);

  try {
    const merchant = await resolveRevolutMerchantContext(supabase, "live");
    const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
    const stripe = stripeKey
      ? new Stripe(stripeKey, { apiVersion: "2025-08-27.basil" })
      : null;
    const { data: dbCustomer } = await supabase
      .from("customers")
      .select("stripe_customer_id")
      .eq("user_id", userId)
      .maybeSingle();
    const stripeCustomerId = (dbCustomer?.stripe_customer_id as string | null) ?? null;

    const isSaveCardConfirm = body.expect_saved_card_token === true;
    const defaultMaxWaitMs = isSaveCardConfirm ? 10_000 : 22_000;
    const requestedMaxWaitMs = Number.isFinite(body.max_wait_ms)
      ? Math.floor(Number(body.max_wait_ms))
      : null;
    const maxWaitMs = requestedMaxWaitMs == null
      ? defaultMaxWaitMs
      : Math.max(0, Math.min(defaultMaxWaitMs, requestedMaxWaitMs));
    const confirmation = await verifyRevolutOrderConfirmedForBooking(
      supabase,
      merchant.environment,
      merchant.secretKey,
      orderId,
      {
        maxWaitMs,
        pollIntervalMs: isSaveCardConfirm ? 250 : (maxWaitMs === 0 ? 0 : 500),
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
      const saveCardRequested =
        typeof body.save_card_requested === "boolean"
          ? body.save_card_requested
          : null;

      if (saveCardRequested !== null) {
        await recordPaymentSessionSaveCardConsent(supabase, {
          providerOrderId: order.id,
          clientActionId: body.client_action_id ?? order.metadata?.client_action_id ?? null,
          customerId: userId,
          saveCardRequested,
          consentAt: body.save_card_consent_at ?? null,
        });
      }

      // Respect explicit opt-out only. Null/undefined = merchant default save.
      let capture: {
        captured: boolean;
        providerPaymentMethodId?: string;
        platformPaymentMethodId?: string | null;
        tokenizationFailed?: boolean;
      } = { captured: false };

      // P0: mark hold authorised BEFORE token capture so create-trip is never blocked
      // by Revolut payment-method polling (full capture can sleep 60s+).
      await markPaymentSessionAuthorised(supabase, {
        providerOrderId: order.id,
        clientActionId: body.client_action_id ?? order.metadata?.client_action_id ?? null,
        verifiedBy: "confirm-revolut-payment",
      });

      if (saveCardRequested === false) {
        console.info("[confirm-revolut-payment] skip token capture — save_card_requested=false", {
          orderId: order.id,
        });
      } else {
        const wantsSavedToken =
          saveCardRequested === true
          || body.expect_saved_card_token === true
          || isSaveCardPurpose;
        // Booking path: one quick attempt only. Wallet setup may await a bit more.
        const awaitCapture = isSaveCardPurpose && body.expect_saved_card_token === true;
        const captureArgs = {
          environment: merchant.environment,
          secretKey: merchant.secretKey,
          orderId: order.id,
          userId,
          platformPaymentMethodId: platformPmId,
          orderMetadata: order.metadata ?? undefined,
          markFailedOnMiss: awaitCapture && Boolean(platformPmId),
          quickCapture: true,
          stripe,
          stripeCustomerId,
        } as const;

        if (awaitCapture) {
          capture = await finalizeRevolutTokenCapture(supabase, captureArgs);
        } else {
          capture = await finalizeRevolutTokenCapture(supabase, captureArgs);
          if (!capture.captured && wantsSavedToken) {
            scheduleBackgroundTokenCapture(() =>
              finalizeRevolutTokenCapture(supabase, {
                ...captureArgs,
                quickCapture: false,
                markFailedOnMiss: false,
              })
            );
          }
        }

        if ((saveCardRequested === true || body.expect_saved_card_token === true)
          && capture.providerPaymentMethodId) {
          await recordPaymentSessionSaveCardConsent(supabase, {
            providerOrderId: order.id,
            clientActionId: body.client_action_id ?? order.metadata?.client_action_id ?? null,
            customerId: userId,
            saveCardRequested: true,
            consentAt: body.save_card_consent_at ?? null,
            providerPaymentMethodId: capture.providerPaymentMethodId,
          });
        }
      }

      if (
        isSaveCardPurpose
        && body.expect_saved_card_token === true
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
        save_card_requested: saveCardRequested,
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
      const saveCardRequested =
        typeof body.save_card_requested === "boolean"
          ? body.save_card_requested
          : null;
      if (saveCardRequested !== null) {
        await recordPaymentSessionSaveCardConsent(supabase, {
          providerOrderId: orderId,
          clientActionId: body.client_action_id ?? fresh?.metadata?.client_action_id ?? null,
          customerId: userId,
          saveCardRequested,
          consentAt: body.save_card_consent_at ?? null,
        });
      }
      await markPaymentSessionAuthorised(supabase, {
        providerOrderId: orderId,
        clientActionId: body.client_action_id ?? fresh?.metadata?.client_action_id ?? null,
        verifiedBy: "confirm-revolut-payment",
      });
      let capture: {
        captured: boolean;
        providerPaymentMethodId?: string;
        platformPaymentMethodId?: string | null;
        tokenizationFailed?: boolean;
      } = { captured: false };
      if (fresh?.metadata && saveCardRequested !== false) {
        const wantsSavedToken =
          saveCardRequested === true
          || body.expect_saved_card_token === true
          || isSaveCardPurpose;
        capture = await finalizeRevolutTokenCapture(supabase, {
          environment: merchant.environment,
          secretKey: merchant.secretKey,
          orderId,
          userId,
          platformPaymentMethodId: platformPmId,
          orderMetadata: fresh.metadata,
          markFailedOnMiss: isSaveCardPurpose
            && body.expect_saved_card_token === true
            && Boolean(platformPmId),
          quickCapture: true,
          stripe,
          stripeCustomerId,
        });
        if (!capture.captured && wantsSavedToken && !(isSaveCardPurpose && body.expect_saved_card_token === true)) {
          scheduleBackgroundTokenCapture(() =>
            finalizeRevolutTokenCapture(supabase, {
              environment: merchant.environment,
              secretKey: merchant.secretKey,
              orderId,
              userId,
              platformPaymentMethodId: platformPmId,
              orderMetadata: fresh.metadata,
              quickCapture: false,
              stripe,
              stripeCustomerId,
            })
          );
        }
      }
      return json({
        confirmed: true,
        failed: false,
        state: freshState,
        confirmed_via: "merchant_api_last_chance",
        order_id: orderId,
        token_captured: capture.captured === true,
        tokenization_failed: capture.tokenizationFailed === true,
        provider_reference: capture.providerPaymentMethodId ?? null,
        platform_payment_method_id: capture.platformPaymentMethodId ?? platformPmId,
        save_card_requested: saveCardRequested,
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
