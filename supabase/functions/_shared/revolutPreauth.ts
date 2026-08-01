import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  buildPreauthIdempotencyKey,
  recordPaymentAuthorizationEvent,
} from "./dynamicPaymentWorkflow.ts";
import { humanizeRevolutPreauthCustomerError } from "./revolutCustomerError.ts";
import { resolveRevolutMerchantContext } from "./revolutMerchantContext.ts";
import {
  isRevolutAuthorisedState,
  isRevolutInFlightState,
} from "./revolutPaymentConfirmation.ts";
import {
  createRevolutOrder,
  isRevolutPaymentAuthenticationChallenge,
  isRevolutPaymentAuthorisedState,
  isRevolutPaymentFailedState,
  listRevolutCustomerPaymentMethods,
  payRevolutOrderWithSavedCard,
  retrieveRevolutOrder,
  retrieveRevolutOrderPayment,
} from "./revolutOrders.ts";
import {
  captureRevolutProviderTokenFromOrder,
  invalidateRevolutProviderToken,
  lookupProviderPaymentMethodToken,
  ONECAB_PENDING_PLATFORM_PM_PREFIX,
} from "./customerSavedPaymentMethodTokens.ts";
import { ensureRevolutCustomerForBooking } from "./revolutCustomers.ts";
import { upsertPaymentSessionPending, markPaymentSessionAuthorised, loadPaymentSession } from "./paymentSessionSSOT.ts";
import type { ProviderEnvironment } from "./paymentProviders/types.ts";
import { createBookingWaterfallCollector } from "./bookingWaterfallTelemetry.ts";
import {
  isRevolutBookingPreauthHoldState,
} from "./revolutPaymentConfirmation.ts";
import { isRevolutWrongCaptureBeforeTripComplete } from "./revolutPreauthReleaseSSOT.ts";
import { validateCanonicalBookingSnapshot } from "../../../shared/bookingSnapshotSSOT.ts";
import { assertBookingPreauthAmount } from "./bookingPreauthAmountGuardSSOT.ts";
import {
  authorisedHoldMatchesBooking,
  classifyRevolutOrderForBookingRetry,
} from "./revolutPaymentAttemptStateSSOT.ts";

export { isRevolutAuthorisedState } from "./revolutPaymentConfirmation.ts";

const REVOLUT_REUSABLE_STATES = new Set(["PENDING", "PROCESSING", "AUTHORISED"]);

export type RevolutPreauthInput = {
  supabase: SupabaseClient;
  environment: ProviderEnvironment;
  authorisedAmountPence: number;
  estimatedTotalPence: number;
  bufferPence: number;
  paymentCurrency: string;
  tripId: string | null;
  clientActionId: string | null;
  idempotencyKeySuffix: string;
  metadataExtra: Record<string, string>;
  paymentMethodType?: string | null;
  userId?: string | null;
  platformPaymentMethodId?: string | null;
  bookingSnapshot?: Record<string, unknown> | null;
  fareSnapshot?: Record<string, unknown> | null;
  customerId?: string | null;
  customerEmail?: string | null;
  customerName?: string | null;
  corsHeaders: Record<string, string>;
  logStep: (step: string, details?: unknown) => void;
};

export async function createRevolutPreauthResponse(
  input: RevolutPreauthInput,
): Promise<Response> {
  const {
    supabase,
    environment,
    authorisedAmountPence,
    estimatedTotalPence,
    bufferPence,
    paymentCurrency,
    tripId,
    clientActionId,
    idempotencyKeySuffix,
    metadataExtra,
    paymentMethodType,
    userId,
    platformPaymentMethodId,
    bookingSnapshot: bookingSnapshotInput,
    fareSnapshot,
    customerId,
    customerEmail,
    customerName,
    corsHeaders,
    logStep,
  } = input;

  let bookingSnapshot = bookingSnapshotInput;

  // Fail closed: booking preauth must never create a £1 vault verification hold.
  const amountGuard = assertBookingPreauthAmount({
    estimatedTotalPence,
    authorisedAmountPence,
  });
  if (!amountGuard.ok) {
    logStep("BOOKING_PREAUTH_AMOUNT_REJECTED", {
      code: amountGuard.code,
      estimatedTotalPence,
      authorisedAmountPence,
      clientActionId,
    });
    return new Response(JSON.stringify({
      error: amountGuard.message,
      error_code: amountGuard.code,
      code: amountGuard.code,
      charge_state: "no_charge",
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 422,
    });
  }

  let merchant;
  try {
    merchant = await resolveRevolutMerchantContext(supabase, environment);
  } catch (err) {
    const message = humanizeRevolutPreauthCustomerError((err as Error)?.message);
    return new Response(JSON.stringify({
      error: message,
      code: "PAYMENT_GATEWAY_NOT_CONFIGURED",
      charge_state: "no_charge",
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 503,
    });
  }

  const { secretKey, publicKey } = merchant;
  const holdStartedAt = Date.now();
  const idempotencyKey = buildPreauthIdempotencyKey({
    tripId,
    clientActionId,
  });
  // New-card booking (no saved platform PM): allocate pending vault id so
  // confirm/webhook can persist Revolut savePaymentMethodFor tokens.
  // Saved-card booking already passes platformPaymentMethodId.
  const methodType = String(paymentMethodType ?? "card").toLowerCase();
  let resolvedPlatformPaymentMethodId = platformPaymentMethodId?.trim() || null;
  if (
    !resolvedPlatformPaymentMethodId
    && userId
    && (methodType === "card" || methodType === "")
  ) {
    resolvedPlatformPaymentMethodId =
      `${ONECAB_PENDING_PLATFORM_PM_PREFIX}${crypto.randomUUID()}`;
    logStep("Allocated pending platform payment method for card save", {
      platformPaymentMethodId: resolvedPlatformPaymentMethodId,
    });
  }
  const savedCardContext = Boolean(platformPaymentMethodId);
  let paymentSessionId: string | null = null;
  const bookingWaterfall = createBookingWaterfallCollector({
    client_action_id: clientActionId,
    trip_id: tripId,
  });
  bookingWaterfall.recordStep({
    step: "revolut_order_created",
    start_time_ms: holdStartedAt,
    finish_time_ms: holdStartedAt,
    source: "revolutPreauth.ts:hold_start",
    metadata: { hold_start_ms: holdStartedAt },
  });

  let existingOrderId: string | null = null;
  if (clientActionId) {
    const existingSession = await loadPaymentSession(supabase, { clientActionId });
    existingOrderId = (existingSession?.provider_order_id as string | undefined) ?? null;
    paymentSessionId = (existingSession?.id as string | undefined) ?? null;
    if (existingOrderId) {
      logStep("Payment session idempotent reuse candidate", {
        clientActionId,
        orderId: existingOrderId,
        sessionId: paymentSessionId,
      });
    }
  }

  if (!existingOrderId && (clientActionId || tripId)) {
    const { data: ledgerRow } = await supabase
      .from("payment_authorization_ledger")
      .select("stripe_payment_intent_id")
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();

    existingOrderId = ledgerRow?.stripe_payment_intent_id as string | null;
  }

  if (existingOrderId) {
    try {
      const existing = await retrieveRevolutOrder(environment, secretKey, existingOrderId);
      const state = String(existing.state ?? "").toUpperCase();
      const retryDecision = classifyRevolutOrderForBookingRetry(state);

      // Manually cancelled / failed / completed — never continue booking on this draft.
      if (retryDecision === "terminal_block") {
        logStep("Revolut order terminal — block booking continuation", {
          orderId: existing.id,
          state,
          amount: existing.amount ?? null,
        });
        return new Response(JSON.stringify({
          error: humanizeRevolutPreauthCustomerError(
            state === "CANCELLED" || state === "CANCELED"
              ? "Payment was cancelled. Start a new booking to try again."
              : "Payment failed. Start a new booking to try again.",
          ),
          code: "PAYMENT_TERMINAL",
          error_code: "PAYMENT_TERMINAL",
          provider_state: state,
          provider_order_id: existing.id,
          charge_state: "no_charge",
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 409,
        });
      }

      if (
        retryDecision === "reuse_unresolved" ||
        retryDecision === "reuse_authorised" ||
        REVOLUT_REUSABLE_STATES.has(state)
      ) {
        logStep("Revolut order idempotent reuse", {
          orderId: existing.id,
          state,
          decision: retryDecision,
          amount: existing.amount ?? null,
        });
        if (clientActionId && !paymentSessionId) {
          const existingSession = await loadPaymentSession(supabase, { clientActionId });
          paymentSessionId = (existingSession?.id as string | undefined) ?? null;
        }
        if (isRevolutWrongCaptureBeforeTripComplete(state)) {
          return new Response(JSON.stringify({
            error: humanizeRevolutPreauthCustomerError("Payment already captured — cannot reuse for booking"),
            code: "PAYMENT_INVARIANT_VIOLATION",
            charge_state: "hold_possible",
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
            status: 409,
          });
        }
        if (isRevolutBookingPreauthHoldState(state)) {
          const amountOk = authorisedHoldMatchesBooking({
            orderAmountMinor: existing.amount,
            orderCurrency: existing.currency,
            expectedAmountMinor: authorisedAmountPence,
            expectedCurrency: paymentCurrency,
          });
          if (!amountOk) {
            logStep("Revolut authorised hold amount mismatch — block", {
              orderId: existing.id,
              orderAmount: existing.amount ?? null,
              expected: authorisedAmountPence,
            });
            return new Response(JSON.stringify({
              error: humanizeRevolutPreauthCustomerError(
                "Authorised amount does not match this fare. Start a new booking.",
              ),
              code: "PAYMENT_AMOUNT_MISMATCH",
              error_code: "PAYMENT_AMOUNT_MISMATCH",
              charge_state: "hold_possible",
            }), {
              headers: { ...corsHeaders, "Content-Type": "application/json" },
              status: 409,
            });
          }
          await markPaymentSessionAuthorised(supabase, {
            providerOrderId: existing.id,
            clientActionId,
          });
          bookingWaterfall.completeStep(
            "revolut_order_created",
            "revolutPreauth.ts:retrieveRevolutOrder(idempotent)",
            { order_id: existing.id, idempotent: true },
          );
          if (paymentSessionId) {
            bookingWaterfall.completeStep(
              "payment_session_created",
              "revolutPreauth.ts:loadPaymentSession(idempotent)",
              { payment_session_id: paymentSessionId, idempotent: true },
            );
          }
          bookingWaterfall.completeStep(
            "revolut_authorised",
            "revolutPreauth.ts:retrieveRevolutOrder(idempotent)",
            { order_id: existing.id, idempotent: true },
          );
          return revolutSavedCardAuthorisedResponse({
            orderId: existing.id,
            authorisedAmountPence,
            estimatedTotalPence,
            bufferPence,
            publicKey,
            idempotent: true,
            paymentSessionId,
            corsHeaders,
            holdStartedAt,
            waterfallFragment: bookingWaterfall.toResponseFragment(),
          });
        }

        if (userId && platformPaymentMethodId) {
          const savedAttempt = await attemptRevolutSavedCardCharge({
            supabase,
            environment,
            secretKey,
            publicKey,
            orderId: existing.id,
            userId,
            platformPaymentMethodId,
            clientActionId,
            authorisedAmountPence,
            estimatedTotalPence,
            bufferPence,
            paymentSessionId,
            corsHeaders,
            logStep,
            holdStartedAt,
          });
          if (savedAttempt) return savedAttempt;
        }

        // Unresolved (auth challenge / processing / pending): return same order — never create another.
        return revolutPreauthJsonResponse({
          order: existing,
          authorisedAmountPence,
          estimatedTotalPence,
          bufferPence,
          publicKey,
          idempotent: true,
          savedCardContext,
          paymentSessionId,
          corsHeaders,
          holdStartedAt,
          waterfallFragment: bookingWaterfall.toResponseFragment(),
        });
      }
    } catch (err) {
      logStep("Revolut idempotent lookup warning (non-fatal)", { error: String(err) });
    }
  }

  const orderMetadata = {
    ...metadataExtra,
    type: "trip_preauth",
    estimated_total_pence: String(estimatedTotalPence),
    buffer_pence: String(bufferPence),
    payment_method_type: String(paymentMethodType ?? "card"),
    ...(clientActionId ? { client_action_id: clientActionId } : {}),
    ...(userId ? { customer_user_id: userId } : {}),
    ...(resolvedPlatformPaymentMethodId
      ? { platform_payment_method_id: resolvedPlatformPaymentMethodId }
      : {}),
  };

  let revolutCustomer = null;
  // Attach Revolut customer on every card booking so payWithPopup can show
  // "Securely save card details…" (requires customer.id on the order).
  const needsRevolutCustomer = Boolean(userId && customerEmail?.trim());

  const [tokenRow, revolutCustomerResolved] = await Promise.all([
    userId && platformPaymentMethodId
      ? lookupProviderPaymentMethodToken(supabase, {
        userId,
        platformPaymentMethodId,
        paymentProvider: "revolut",
      })
      : Promise.resolve(null),
    needsRevolutCustomer
      ? ensureRevolutCustomerForBooking({
        supabase,
        environment,
        secretKey,
        userId: userId!,
        email: customerEmail!,
        fullName: customerName,
      })
      : Promise.resolve(null),
  ]);

  if (revolutCustomerResolved) {
    revolutCustomer = revolutCustomerResolved;
    logStep("Revolut customer resolved", {
      hasId: Boolean(revolutCustomer?.id),
      cached: Boolean(revolutCustomer?.id),
    });
  }

  let order;
  try {
    // Defense in depth: never create a NEW Revolut order without a canonical snapshot.
    // (create-preauth already validates; this blocks any other caller.)
    const snapCheck = validateCanonicalBookingSnapshot(bookingSnapshot ?? null);
    if (!snapCheck.ok) {
      logStep("BOOKING_SNAPSHOT_REJECTED_BEFORE_ORDER", {
        error_code: snapCheck.error_code,
        missing_fields: snapCheck.missing_fields,
        client_action_id: clientActionId,
      });
      return new Response(JSON.stringify({
        error: snapCheck.message,
        error_code: snapCheck.error_code,
        missing_fields: snapCheck.missing_fields,
        charge_state: "no_charge",
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 422,
      });
    }
    bookingSnapshot = snapCheck.snapshot as unknown as Record<string, unknown>;

    bookingWaterfall.startStep(
      "revolut_order_created",
      "revolutPreauth.ts:createRevolutOrder",
    );
    order = await createRevolutOrder({
      environment,
      secretKey,
      amountMinor: authorisedAmountPence,
      currency: paymentCurrency,
      tripId: tripId ?? idempotencyKeySuffix,
      description: tripId ? `ONECAB trip ${tripId}` : "ONECAB ride pre-authorisation",
      metadata: orderMetadata,
      customer: revolutCustomer ?? undefined,
    });
  } catch (err) {
    logStep("Revolut order create failed", { error: String(err) });
    return new Response(JSON.stringify({
      error: humanizeRevolutPreauthCustomerError((err as Error)?.message),
      code: "PAYMENT_SETUP_FAILED",
      charge_state: "no_charge",
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 402,
    });
  }

  logStep("Revolut order created", {
    orderId: order.id,
    state: order.state,
    amount: order.amount,
    hasToken: Boolean(order.token),
    platformPaymentMethodId: resolvedPlatformPaymentMethodId ?? null,
  });
  bookingWaterfall.completeStep(
    "revolut_order_created",
    "revolutPreauth.ts:createRevolutOrder",
    { order_id: order.id, state: order.state ?? null },
  );

  if (userId && clientActionId && metadataExtra.service_area_id) {
    const sessionResult = await upsertPaymentSessionPending(supabase, {
      clientActionId,
      userId,
      customerId: customerId ?? null,
      serviceAreaId: metadataExtra.service_area_id,
      paymentProvider: "revolut",
      providerOrderId: order.id,
      authorisedAmountPence,
      estimatedTotalPence,
      bufferPence,
      fareSnapshot: fareSnapshot ?? {},
      bookingSnapshot: bookingSnapshot ?? {},
      platformPaymentMethodId: resolvedPlatformPaymentMethodId ?? null,
      paymentMethod: paymentMethodType ?? "card",
      metadata: {
        trip_id: tripId,
        idempotency_key_suffix: idempotencyKeySuffix,
        idempotency_key: idempotencyKey,
      },
    });
    paymentSessionId = sessionResult.sessionId;
    if (!paymentSessionId) {
      logStep("Revolut payment session upsert failed", {
        error: sessionResult.error ?? "unknown",
        orderId: order.id,
        clientActionId,
      });
    }
    bookingWaterfall.completeStep(
      "payment_session_created",
      "revolutPreauth.ts:upsertPaymentSessionPending",
      { payment_session_id: paymentSessionId },
    );

    // Scan & Go: short-lived driver hold while payment is in flight (not a trip).
    try {
      const { acquireScanGoDriverHoldFromSnapshot } = await import("./scanGoDriverHoldSSOT.ts");
      const hold = await acquireScanGoDriverHoldFromSnapshot(supabase, {
        bookingSnapshot: bookingSnapshot ?? null,
        userId,
        paymentSessionId,
        clientActionId,
      });
      if (hold && !hold.ok) {
        logStep("SCAN_GO_DRIVER_HOLD_REJECTED", {
          error_code: hold.error_code,
          message: hold.message,
          orderId: order.id,
          clientActionId,
        });
        try {
          const { cancelRevolutOrder } = await import("./revolutOrders.ts");
          await cancelRevolutOrder(environment, secretKey, order.id);
        } catch (cancelErr) {
          logStep("SCAN_GO_HOLD_CONFLICT_ORDER_CANCEL_FAILED", {
            orderId: order.id,
            error: String(cancelErr),
          });
        }
        return new Response(JSON.stringify({
          error: hold.message
            ?? "This driver is temporarily reserved. Please try again shortly.",
          error_code: hold.error_code ?? "DRIVER_HOLD_CONFLICT",
          charge_state: "no_charge",
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 409,
        });
      }
      if (hold?.ok) {
        logStep("SCAN_GO_DRIVER_HOLD_ACQUIRED", {
          hold_id: hold.hold_id,
          idempotent: hold.idempotent === true,
          clientActionId,
        });
      }
    } catch (holdErr) {
      logStep("SCAN_GO_DRIVER_HOLD_ERROR", { error: String(holdErr), clientActionId });
    }
  }

  if (clientActionId || tripId) {
    await recordPaymentAuthorizationEvent(supabase, {
      tripId: tripId ?? clientActionId ?? "pending",
      fareRevisionNumber: 0,
      operation: "initial_auth",
      idempotencyKey,
      stripePaymentIntentId: order.id,
      amountPence: authorisedAmountPence,
      status: isRevolutAuthorisedState(order.state) || isRevolutInFlightState(order.state)
        ? "pending"
        : "pending",
      metadata: {
        provider: "revolut",
        client_action_id: clientActionId,
        provider_order_id: order.id,
      },
    }).catch((err) => {
      logStep("Revolut auth ledger warning", { error: String(err) });
    });
  }

  if (userId && platformPaymentMethodId) {
    if (tokenRow?.provider_payment_method_id) {
      const savedAttempt = await attemptRevolutSavedCardCharge({
        supabase,
        environment,
        secretKey,
        publicKey,
        orderId: order.id,
        userId,
        platformPaymentMethodId,
        clientActionId,
        authorisedAmountPence,
        estimatedTotalPence,
        bufferPence,
        paymentSessionId,
        corsHeaders,
        logStep,
        holdStartedAt,
      });
      if (savedAttempt) return savedAttempt;
      logStep("Revolut saved-card charge failed despite provider token", {
        orderId: order.id,
        platformPaymentMethodId,
        providerPaymentMethodId: tokenRow?.provider_payment_method_id ?? null,
        tokenizationStatus: tokenRow?.tokenization_status ?? null,
        revolutVerified: tokenRow?.revolut_verified ?? null,
      });
      return new Response(JSON.stringify({
        error: humanizeRevolutPreauthCustomerError("Saved card payment failed"),
        code: "saved_card_charge_failed",
        charge_state: "no_charge",
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 402,
      });
    }
    logStep("Revolut saved-card token missing for platform PM", {
      orderId: order.id,
      platformPaymentMethodId,
    });
  }

  return revolutPreauthJsonResponse({
    order,
    authorisedAmountPence,
    estimatedTotalPence,
    bufferPence,
    publicKey,
    savedCardContext,
    savedCardBlockingReason: platformPaymentMethodId
      ? "provider_token_missing_in_db"
      : null,
    paymentSessionId,
    corsHeaders,
    holdStartedAt,
    waterfallFragment: bookingWaterfall.toResponseFragment(),
  });
}

async function attemptRevolutSavedCardCharge(args: {
  supabase: SupabaseClient;
  environment: ProviderEnvironment;
  secretKey: string;
  publicKey: string | null;
  orderId: string;
  userId: string;
  platformPaymentMethodId: string;
  clientActionId?: string | null;
  authorisedAmountPence: number;
  estimatedTotalPence: number;
  bufferPence: number;
  paymentSessionId?: string | null;
  corsHeaders: Record<string, string>;
  logStep: (step: string, details?: unknown) => void;
  holdStartedAt?: number;
}): Promise<Response | null> {
  const tokenRow = await lookupProviderPaymentMethodToken(args.supabase, {
    userId: args.userId,
    platformPaymentMethodId: args.platformPaymentMethodId,
    paymentProvider: "revolut",
  });
  if (!tokenRow?.provider_payment_method_id) {
    args.logStep("Revolut saved-card token missing for platform PM", {
      orderId: args.orderId,
      platformPaymentMethodId: args.platformPaymentMethodId,
    });
    return null;
  }

  args.logStep("Revolut saved-card preauth attempt", {
    orderId: args.orderId,
    platformPaymentMethodId: args.platformPaymentMethodId,
    providerPaymentMethodId: tokenRow.provider_payment_method_id,
    tokenizationStatus: tokenRow.tokenization_status ?? null,
    revolutVerified: tokenRow.revolut_verified ?? null,
  });

  try {
    let initiator: "customer" | "merchant" = "customer";
    try {
      const { data: customerRow } = await args.supabase
        .from("customers")
        .select("revolut_customer_id")
        .eq("user_id", args.userId)
        .maybeSingle();
      const revolutCustomerId = String(customerRow?.revolut_customer_id ?? "").trim();
      if (revolutCustomerId) {
        const methods = await listRevolutCustomerPaymentMethods(
          args.environment,
          args.secretKey,
          revolutCustomerId,
        );
        const match = methods.find((m) =>
          String(m.id ?? "").trim() === tokenRow.provider_payment_method_id
        );
        if (String(match?.saved_for ?? "").toLowerCase() === "merchant") {
          initiator = "merchant";
        }
      }
    } catch (initiatorErr) {
      args.logStep("Revolut saved-card initiator lookup warning", {
        error: String(initiatorErr),
      });
    }

    const payment = await payRevolutOrderWithSavedCard(
      args.environment,
      args.secretKey,
      args.orderId,
      tokenRow.provider_payment_method_id,
      initiator,
    );
    const resolved = await resolveSavedCardPaymentOutcome({
      environment: args.environment,
      secretKey: args.secretKey,
      orderId: args.orderId,
      payment,
      logStep: args.logStep,
    });
    if (resolved.kind === "authorised") {
      if (args.clientActionId) {
        await markPaymentSessionAuthorised(args.supabase, {
          providerOrderId: args.orderId,
          clientActionId: args.clientActionId,
        });
      }
      return revolutSavedCardAuthorisedResponse({
        orderId: args.orderId,
        authorisedAmountPence: args.authorisedAmountPence,
        estimatedTotalPence: args.estimatedTotalPence,
        bufferPence: args.bufferPence,
        publicKey: args.publicKey,
        paymentSessionId: args.paymentSessionId ?? null,
        corsHeaders: args.corsHeaders,
        holdStartedAt: args.holdStartedAt,
      });
    }
    if (resolved.kind === "requires_3ds") {
      return new Response(JSON.stringify({
        success: true,
        provider: "revolut",
        payment_intent_id: args.orderId,
        provider_order_id: args.orderId,
        revolut_public_key: args.publicKey,
        authorised_amount_pence: args.authorisedAmountPence,
        estimated_total_pence: args.estimatedTotalPence,
        buffer_pence: args.bufferPence,
        status: "authentication_challenge",
        saved_card_flow: true,
        requires_3ds: true,
        provider_payment_id: resolved.paymentId,
        authentication_acs_url: resolved.acsUrl,
      }), {
        headers: { ...args.corsHeaders, "Content-Type": "application/json" },
        status: 200,
      });
    }
    if (resolved.kind === "failed") {
      args.logStep("Revolut saved-card charge declined", {
        orderId: args.orderId,
        platformPaymentMethodId: args.platformPaymentMethodId,
        providerPaymentMethodId: tokenRow.provider_payment_method_id,
        declineReason: resolved.reason ?? null,
      });
      await invalidateRevolutProviderToken(args.supabase, {
        userId: args.userId,
        platformPaymentMethodId: args.platformPaymentMethodId,
        orderId: args.orderId,
        reason: resolved.reason ?? "saved_card_charge_failed",
      });
      return new Response(JSON.stringify({
        error: humanizeRevolutPreauthCustomerError(resolved.reason ?? "Payment failed"),
        code: "card_declined",
        charge_state: "no_charge",
      }), {
        headers: { ...args.corsHeaders, "Content-Type": "application/json" },
        status: 402,
      });
    }
    args.logStep("Revolut saved-card payment still settling", {
      orderId: args.orderId,
      paymentState: resolved.paymentState,
    });
    return new Response(JSON.stringify({
      error: humanizeRevolutPreauthCustomerError(
        "Saved card payment is still processing. Please try again in a moment.",
      ),
      code: "saved_card_pending",
      charge_state: "no_charge",
    }), {
      headers: { ...args.corsHeaders, "Content-Type": "application/json" },
      status: 409,
    });
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : String(err);
    args.logStep("Revolut saved-card preauth failed", {
      orderId: args.orderId,
      platformPaymentMethodId: args.platformPaymentMethodId,
      providerPaymentMethodId: tokenRow.provider_payment_method_id,
      error: errMessage,
    });
    await invalidateRevolutProviderToken(args.supabase, {
      userId: args.userId,
      platformPaymentMethodId: args.platformPaymentMethodId,
      orderId: args.orderId,
      reason: errMessage,
    });
    return new Response(JSON.stringify({
      error: humanizeRevolutPreauthCustomerError(errMessage || "Saved card payment failed"),
      code: "saved_card_charge_failed",
      charge_state: "no_charge",
      provider_error: errMessage,
    }), {
      headers: { ...args.corsHeaders, "Content-Type": "application/json" },
      status: 402,
    });
  }
}

async function resolveSavedCardPaymentOutcome(args: {
  environment: ProviderEnvironment;
  secretKey: string;
  orderId: string;
  payment: { id: string; state?: string; authentication_challenge?: { acs_url?: string } };
  logStep: (step: string, details?: unknown) => void;
}): Promise<
  | { kind: "authorised" }
  | { kind: "requires_3ds"; paymentId: string; acsUrl: string }
  | { kind: "failed"; reason?: string }
  | { kind: "in_flight"; paymentState?: string }
> {
  const pollDelaysMs = [0, 150, 300, 600, 1000, 2000, 3000];
  let latest = args.payment;
  for (const delayMs of pollDelaysMs) {
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    latest = await retrieveRevolutOrderPayment(args.environment, args.secretKey, latest.id);
    const state = String(latest.state ?? "");
    args.logStep("Revolut saved-card payment poll", { paymentId: latest.id, state });

    if (isRevolutPaymentFailedState(state)) {
      return { kind: "failed", reason: latest.decline_reason ?? state };
    }
    if (isRevolutPaymentAuthenticationChallenge(latest)) {
      const acsUrl = latest.authentication_challenge?.acs_url?.trim();
      if (acsUrl) {
        return { kind: "requires_3ds", paymentId: latest.id, acsUrl };
      }
    }
    if (isRevolutPaymentAuthorisedState(state)) {
      // Payment-level AUTHORISED can still soft-fail — require order AUTHORISED.
      const order = await retrieveRevolutOrder(args.environment, args.secretKey, args.orderId);
      const orderState = String(order.state ?? "").toUpperCase();
      args.logStep("Revolut saved-card order confirm", {
        orderId: args.orderId,
        orderState,
        paymentState: state,
      });
      if (isRevolutAuthorisedState(orderState)) {
        return { kind: "authorised" };
      }
      if (["FAILED", "CANCELLED", "CANCELED", "DECLINED"].includes(orderState)) {
        return { kind: "failed", reason: orderState };
      }
      // Keep polling while order still settling.
    }
  }

  const finalState = String(latest.state ?? "");
  if (isRevolutPaymentFailedState(finalState)) {
    return { kind: "failed", reason: latest.decline_reason ?? finalState };
  }
  if (isRevolutPaymentAuthenticationChallenge(latest) && latest.authentication_challenge?.acs_url) {
    return {
      kind: "requires_3ds",
      paymentId: latest.id,
      acsUrl: latest.authentication_challenge.acs_url,
    };
  }
  if (isRevolutPaymentAuthorisedState(finalState)) {
    const order = await retrieveRevolutOrder(args.environment, args.secretKey, args.orderId);
    const orderState = String(order.state ?? "").toUpperCase();
    if (isRevolutAuthorisedState(orderState)) {
      return { kind: "authorised" };
    }
    return { kind: "in_flight", paymentState: `${finalState}/order:${orderState}` };
  }
  return { kind: "in_flight", paymentState: finalState };
}

function revolutPreauthMilestones(holdStartedAt: number): {
  booking_milestones: { hold_start_ms: number; hold_authorised_ms: number; hold_duration_ms: number };
} {
  const holdAuthorisedAt = Date.now();
  return {
    booking_milestones: {
      hold_start_ms: holdStartedAt,
      hold_authorised_ms: holdAuthorisedAt,
      hold_duration_ms: holdAuthorisedAt - holdStartedAt,
    },
  };
}

function revolutSavedCardAuthorisedResponse(args: {
  orderId: string;
  authorisedAmountPence: number;
  estimatedTotalPence: number;
  bufferPence: number;
  publicKey: string | null;
  idempotent?: boolean;
  paymentSessionId?: string | null;
  corsHeaders: Record<string, string>;
  waterfallFragment?: { booking_waterfall: import("../../../shared/bookingWaterfallSSOT.ts").BookingWaterfallServerStepInput[] };
  holdStartedAt?: number;
}): Response {
  return new Response(JSON.stringify({
    success: true,
    provider: "revolut",
    payment_intent_id: args.orderId,
    provider_order_id: args.orderId,
    payment_session_id: args.paymentSessionId ?? null,
    revolut_public_key: args.publicKey,
    authorised_amount_pence: args.authorisedAmountPence,
    estimated_total_pence: args.estimatedTotalPence,
    buffer_pence: args.bufferPence,
    status: "AUTHORISED",
    saved_card_flow: true,
    saved_card_authorised: true,
    idempotent: args.idempotent === true,
    ...(args.holdStartedAt ? revolutPreauthMilestones(args.holdStartedAt) : {}),
    ...(args.waterfallFragment ?? {}),
  }), {
    headers: { ...args.corsHeaders, "Content-Type": "application/json" },
    status: 200,
  });
}

function revolutPreauthJsonResponse(args: {
  order: { id: string; token?: string; checkout_url?: string; state?: string };
  authorisedAmountPence: number;
  estimatedTotalPence: number;
  bufferPence: number;
  publicKey: string | null;
  idempotent?: boolean;
  savedCardContext?: boolean;
  savedCardBlockingReason?: string | null;
  paymentSessionId?: string | null;
  corsHeaders: Record<string, string>;
  waterfallFragment?: { booking_waterfall: import("../../../shared/bookingWaterfallSSOT.ts").BookingWaterfallServerStepInput[] };
  holdStartedAt?: number;
}): Response {
  const token = args.order.token ?? null;
  if (!token) {
    return new Response(JSON.stringify({
      error: humanizeRevolutPreauthCustomerError("Revolut checkout token missing from order response"),
      code: "PAYMENT_SETUP_FAILED",
      charge_state: "no_charge",
    }), {
      headers: { ...args.corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }

  const savedCardVerify = args.savedCardContext === true;
  const blockingReason = args.savedCardBlockingReason
    ?? (savedCardVerify ? "provider_token_missing_in_db" : null);

  return new Response(JSON.stringify({
    success: true,
    provider: "revolut",
    payment_intent_id: args.order.id,
    client_secret: token,
    provider_order_id: args.order.id,
    payment_session_id: args.paymentSessionId ?? null,
    provider_checkout_token: token,
    provider_checkout_url: args.order.checkout_url ?? null,
    revolut_public_key: args.publicKey,
    authorised_amount_pence: args.authorisedAmountPence,
    estimated_total_pence: args.estimatedTotalPence,
    buffer_pence: args.bufferPence,
    status: args.order.state ?? "PENDING",
    idempotent: args.idempotent === true,
    saved_card_flow: savedCardVerify,
    requires_revolut_verify_checkout: savedCardVerify,
    provider_token_missing: savedCardVerify,
    saved_card_blocking_reason: blockingReason,
    requires_new_card_checkout: !savedCardVerify,
    ...(args.holdStartedAt
      ? { booking_milestones: { hold_start_ms: args.holdStartedAt, checkout_open_ms: Date.now() } }
      : {}),
    ...(args.waterfallFragment ?? {}),
  }), {
    headers: { ...args.corsHeaders, "Content-Type": "application/json" },
    status: 200,
  });
}
