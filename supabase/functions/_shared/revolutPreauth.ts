import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  buildPreauthIdempotencyKey,
  recordPaymentAuthorizationEvent,
} from "./dynamicPaymentWorkflow.ts";
import { humanizeRevolutPreauthCustomerError } from "./revolutCustomerError.ts";
import { ensureRevolutCustomerForBooking } from "./revolutCustomers.ts";
import {
  buildPreauthOrderCreateMetadata,
  customerForStaleOrderRetry,
  planStaleCachedCustomerOrderRetry,
  shouldAttachRevolutCustomerForPreauth,
} from "./revolutPreauthCustomerAttach.ts";
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
import { countUsableSavedRevolutCards, MAX_SAVED_REVOLUT_CARDS } from "./revolutSavedCardVault.ts";
import { upsertPaymentSessionPending, markPaymentSessionAuthorised, markPaymentSessionFailed, loadPaymentSession } from "./paymentSessionSSOT.ts";
import type { ProviderEnvironment } from "./paymentProviders/types.ts";
import { createBookingWaterfallCollector } from "./bookingWaterfallTelemetry.ts";
import {
  isRevolutBookingPreauthHoldState,
} from "./revolutPaymentConfirmation.ts";
import { isRevolutWrongCaptureBeforeTripComplete } from "./revolutPreauthReleaseSSOT.ts";
import { validateCanonicalBookingSnapshot } from "./bookingSnapshotSSOT.ts";
import { assertBookingPreauthAmount } from "./bookingPreauthAmountGuardSSOT.ts";
import {
  authorisedHoldMatchesBooking,
  classifyRevolutOrderForBookingRetry,
} from "./revolutPaymentAttemptStateSSOT.ts";
import {
  buildSavedCardPendingHandoff,
  isTechnicalDeclineReason,
  SAVED_CARD_TERMINAL_FAILURE_THROTTLE_MS,
} from "./savedCardPaymentReconcileSSOT.ts";
import {
  citBrowserEnvironmentErrorResponse,
  parseAndValidateCitBrowserEnvironment,
  type RevolutCitBrowserEnvironment,
} from "./revolutCitBrowserEnvironmentSSOT.ts";
import {
  createPreauthEdgeTiming,
  jsonResponseWithPreauthTiming,
  type PreauthEdgeTiming,
} from "./preauthEdgeTimingSSOT.ts";

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
  /** Explicit rider opt-in. False/absent must not allocate a new vault id or save flag. */
  savePaymentMethod?: boolean;
  /**
   * Required for saved-card Pay (CIT). Validated by caller / create-preauth
   * before order create when possible. Never invent defaults.
   */
  browserEnvironment?: RevolutCitBrowserEnvironment | null;
  corsHeaders: Record<string, string>;
  logStep: (step: string, details?: unknown) => void;
  /** Observability — created by create-preauth so receive→auth is measured. */
  edgeTiming?: PreauthEdgeTiming | null;
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
    savePaymentMethod,
    browserEnvironment,
    corsHeaders,
    logStep,
    edgeTiming: edgeTimingInput,
  } = input;

  let bookingSnapshot = bookingSnapshotInput;
  const edgeTiming = edgeTimingInput ?? createPreauthEdgeTiming();

  // Saved-card CIT Pay requires validated browser environment — fail closed
  // before creating / reusing pay paths that would call Revolut Pay.
  edgeTiming.markValidationStart();
  const savedCardReuse = Boolean(platformPaymentMethodId?.trim());
  let validatedBrowserEnv: RevolutCitBrowserEnvironment | null = null;
  if (savedCardReuse) {
    const parsedEnv = parseAndValidateCitBrowserEnvironment(browserEnvironment);
    if (!parsedEnv.ok) {
      logStep("BROWSER_ENVIRONMENT_REJECTED", {
        code: parsedEnv.code,
        clientActionId,
        hasPlatformPm: true,
      });
      edgeTiming.markValidationEnd();
      return citBrowserEnvironmentErrorResponse(parsedEnv, corsHeaders);
    }
    validatedBrowserEnv = parsedEnv.environment;
  }

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
    edgeTiming.markValidationEnd();
    return jsonResponseWithPreauthTiming({
      error: amountGuard.message,
      error_code: amountGuard.code,
      code: amountGuard.code,
      charge_state: "no_charge",
    }, corsHeaders, 422, edgeTiming);
  }
  edgeTiming.markValidationEnd();

  edgeTiming.markDbLookupStart();
  let merchant;
  try {
    merchant = await resolveRevolutMerchantContext(supabase, environment);
  } catch (err) {
    const message = humanizeRevolutPreauthCustomerError((err as Error)?.message);
    edgeTiming.markDbLookupEnd();
    return jsonResponseWithPreauthTiming({
      error: message,
      code: "PAYMENT_GATEWAY_NOT_CONFIGURED",
      charge_state: "no_charge",
    }, corsHeaders, 503, edgeTiming);
  }
  edgeTiming.markDbLookupEnd();

  const { secretKey, publicKey } = merchant;
  const holdStartedAt = edgeTiming.t0;
  const idempotencyKey = buildPreauthIdempotencyKey({
    tripId,
    clientActionId,
  });
  // New-card booking allocates a pending vault id only when the rider opted in
  // to save and is under MAX_SAVED_REVOLUT_CARDS. Saved-card booking already
  // passes platformPaymentMethodId and must not save again.
  const methodType = String(paymentMethodType ?? "card").toLowerCase();
  let resolvedPlatformPaymentMethodId = platformPaymentMethodId?.trim() || null;
  let saveCardEligible = false;
  if (
    !resolvedPlatformPaymentMethodId
    && savePaymentMethod === true
    && userId
    && (methodType === "card" || methodType === "")
  ) {
    const usable = await countUsableSavedRevolutCards(supabase, userId);
    if (usable >= MAX_SAVED_REVOLUT_CARDS) {
      logStep("Booking card save skipped — vault cap", {
        usable,
        max: MAX_SAVED_REVOLUT_CARDS,
      });
    } else {
      saveCardEligible = true;
      resolvedPlatformPaymentMethodId =
        `${ONECAB_PENDING_PLATFORM_PM_PREFIX}${crypto.randomUUID()}`;
      logStep("Allocated pending platform payment method for explicit card save", {
        platformPaymentMethodId: resolvedPlatformPaymentMethodId,
      });
    }
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
      .select("metadata")
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();

    existingOrderId = String((ledgerRow?.metadata as any)?.provider_order_id ?? "").trim() || null;
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
            edgeTiming,
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
            browserEnvironment: validatedBrowserEnv!,
            edgeTiming,
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
          edgeTiming,
        });
      }
    } catch (err) {
      logStep("Revolut idempotent lookup warning (non-fatal)", { error: String(err) });
    }
  }

  const attachRevolutCustomer = shouldAttachRevolutCustomerForPreauth({
    paymentMethodType,
    saveCardEligible,
    savedCardReuse: savedCardContext,
  });
  const orderMetadata = buildPreauthOrderCreateMetadata({
    metadataExtra,
    estimatedTotalPence,
    bufferPence,
    paymentMethodType,
    saveCardEligible,
    clientActionId,
    userId,
    platformPaymentMethodId: resolvedPlatformPaymentMethodId,
  });

  let revolutCustomer: Awaited<ReturnType<typeof ensureRevolutCustomerForBooking>> = null;
  // Customer id is for explicit card save and saved-card reuse only.
  // Apple Pay / Google Pay must not receive customer — a stale cached id 404s POST /orders
  // before the wallet sheet opens.
  const needsRevolutCustomer = attachRevolutCustomer && Boolean(userId && customerEmail?.trim());

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
      attach: attachRevolutCustomer,
      payment_method_type: paymentMethodType ?? "card",
    });
  } else if (!attachRevolutCustomer) {
    logStep("Revolut customer omitted", {
      payment_method_type: paymentMethodType ?? "card",
      save_card_eligible: saveCardEligible,
      saved_card_reuse: savedCardContext,
    });
  }

  let order;
  const orderCreateFailed = (err: unknown) => {
    const revolutErr = err as { message?: string; status?: number };
    // Plain objects thrown by revolutMerchantRequest stringify as [object Object].
    logStep("Revolut order create failed", {
      error: revolutErr?.message ?? "unknown",
      status: revolutErr?.status ?? null,
    });
    return new Response(JSON.stringify({
      error: humanizeRevolutPreauthCustomerError(revolutErr?.message),
      code: "PAYMENT_SETUP_FAILED",
      charge_state: "no_charge",
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 402,
    });
  };
  const postPreauthOrder = (
    customer: { id?: string; email?: string; full_name?: string } | null,
  ) => createRevolutOrder({
    environment,
    secretKey,
    amountMinor: authorisedAmountPence,
    currency: paymentCurrency,
    tripId: tripId ?? idempotencyKeySuffix,
    description: tripId ? `ONECAB trip ${tripId}` : "ONECAB ride pre-authorisation",
    metadata: orderMetadata,
    customer: customer ?? undefined,
  });

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
    edgeTiming.markRevolutRequestStart();
    const staleCustomerId = revolutCustomer?.id?.trim() || "";
    try {
      order = await postPreauthOrder(revolutCustomer);
    } catch (err) {
      // First POST failed before payment_session insert. A cached customer 404
      // means Revolut did not create the order — one refresh retry is safe.
      const retry = planStaleCachedCustomerOrderRetry({
        sentCachedCustomerId: Boolean(staleCustomerId),
        alreadyRetried: false,
        err,
      });
      if (retry !== "refresh_and_retry" || !userId || !customerEmail?.trim()) {
        edgeTiming.markRevolutRequestEnd();
        return orderCreateFailed(err);
      }
      logStep("Stale Revolut customer on order create — refreshing once", {
        status: (err as { status?: number })?.status ?? null,
      });
      const refreshed = await ensureRevolutCustomerForBooking({
        supabase,
        environment,
        secretKey,
        userId,
        email: customerEmail,
        fullName: customerName,
        ignoreCachedId: true,
      });
      const retryCustomer = customerForStaleOrderRetry({
        staleCustomerId,
        refreshed,
      });
      try {
        order = await postPreauthOrder(retryCustomer);
      } catch (retryErr) {
        edgeTiming.markRevolutRequestEnd();
        return orderCreateFailed(retryErr);
      }
    }
    edgeTiming.markRevolutRequestEnd();
  } catch (err) {
    edgeTiming.markRevolutRequestEnd();
    return orderCreateFailed(err);
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
    edgeTiming.markPersistStart();
    const sessionResult = await upsertPaymentSessionPending(supabase, {
      clientActionId,
      userId,
      customerId: customerId ?? null,
      serviceAreaId: metadataExtra.service_area_id,
      paymentProvider: "revolut",
      providerOrderId: order.id,
      idempotencyKey,
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
    edgeTiming.markPersistEnd();
    if (!paymentSessionId) {
      // P0 fail-closed: never return a usable preauth if the authoritative session
      // row did not persist (Slice A regression: missing idempotency_key).
      logStep("Revolut payment session upsert failed — cancelling order", {
        error: sessionResult.error ?? "unknown",
        orderId: order.id,
        clientActionId,
      });
      try {
        const { cancelRevolutOrder } = await import("./revolutOrders.ts");
        await cancelRevolutOrder(environment, secretKey, order.id);
      } catch (cancelErr) {
        logStep("Session-persist cancel failed", {
          orderId: order.id,
          error: String(cancelErr),
        });
      }
      return new Response(JSON.stringify({
        error:
          "We couldn't complete your booking. Any temporary card hold will be released.",
        code: "PAYMENT_SESSION_PERSIST_FAILED",
        charge_state: "reversed",
        payment_intent_id: order.id,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 500,
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
      providerOrderId: order.id,
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
        browserEnvironment: validatedBrowserEnv!,
        edgeTiming,
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
    edgeTiming,
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
  /** Pre-validated CIT browser environment — never invent defaults. */
  browserEnvironment: RevolutCitBrowserEnvironment;
  edgeTiming: PreauthEdgeTiming;
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
    // Book is always customer-initiated (CIT). `saved_for=merchant` is vault
    // storage only — never select MIT for a customer-tapped Book. Genuine
    // off-session MIT stays in the unwired draft mandate helper (excluded).
    const initiator = "customer" as const;

    // Re-validate immediately before Pay (fail closed if caller omitted).
    const payEnv = parseAndValidateCitBrowserEnvironment(args.browserEnvironment);
    if (!payEnv.ok) {
      args.logStep("BROWSER_ENVIRONMENT_REJECTED_BEFORE_PAY", {
        code: payEnv.code,
        orderId: args.orderId,
      });
      return citBrowserEnvironmentErrorResponse(payEnv, args.corsHeaders);
    }

    args.edgeTiming.markRevolutResponseStart();
    const payment = await payRevolutOrderWithSavedCard(
      args.environment,
      args.secretKey,
      args.orderId,
      tokenRow.provider_payment_method_id,
      payEnv.environment,
      initiator,
    );
    const resolved = await resolveSavedCardPaymentOutcome({
      environment: args.environment,
      secretKey: args.secretKey,
      orderId: args.orderId,
      payment,
      logStep: args.logStep,
    });
    args.edgeTiming.markRevolutResponseEnd();
    if (resolved.kind === "authorised") {
      // P0: never return booking-ready success without an authoritative session row.
      if (args.clientActionId && !args.paymentSessionId) {
        args.logStep("Authorised but payment session missing — cancelling hold", {
          orderId: args.orderId,
          clientActionId: args.clientActionId,
        });
        try {
          const { cancelRevolutOrder } = await import("./revolutOrders.ts");
          await cancelRevolutOrder(args.environment, args.secretKey, args.orderId);
        } catch (cancelErr) {
          args.logStep("Authorised-without-session cancel failed", {
            orderId: args.orderId,
            error: String(cancelErr),
          });
        }
        return new Response(JSON.stringify({
          error:
            "We couldn't complete your booking. Any temporary card hold will be released.",
          code: "PAYMENT_SESSION_PERSIST_FAILED",
          charge_state: "reversed",
          payment_intent_id: args.orderId,
        }), {
          headers: { ...args.corsHeaders, "Content-Type": "application/json" },
          status: 500,
        });
      }
      if (args.clientActionId) {
        args.edgeTiming.markPersistStart();
        await markPaymentSessionAuthorised(args.supabase, {
          providerOrderId: args.orderId,
          clientActionId: args.clientActionId,
        });
        args.edgeTiming.markPersistEnd();
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
        edgeTiming: args.edgeTiming,
      });
    }
    if (resolved.kind === "requires_3ds") {
      return jsonResponseWithPreauthTiming({
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
      }, args.corsHeaders, 200, args.edgeTiming);
    }
    if (resolved.kind === "failed") {
      const declineReason = resolved.reason ?? null;
      const preserveCard = isTechnicalDeclineReason(declineReason);
      args.logStep("Revolut saved-card charge declined", {
        orderId: args.orderId,
        platformPaymentMethodId: args.platformPaymentMethodId,
        providerPaymentMethodId: tokenRow.provider_payment_method_id,
        declineReason,
        preserveSavedCard: preserveCard,
      });
      // Terminalize session out of pending_payment (idempotent). No trip / ledger.
      if (args.clientActionId || args.paymentSessionId) {
        await markPaymentSessionFailed(args.supabase, {
          clientActionId: args.clientActionId ?? null,
          providerOrderId: args.orderId,
          failureReason: declineReason
            ? `REVOLUT_PAYMENT_FAILED:${declineReason}`
            : "REVOLUT_PAYMENT_FAILED",
        }).catch((markErr) => {
          args.logStep("markPaymentSessionFailed after saved-card decline failed", {
            orderId: args.orderId,
            error: String(markErr),
          });
        });
      }
      // Never invalidate vault card on technical_error / provider faults.
      if (!preserveCard) {
        await invalidateRevolutProviderToken(args.supabase, {
          userId: args.userId,
          platformPaymentMethodId: args.platformPaymentMethodId,
          orderId: args.orderId,
          reason: declineReason ?? "saved_card_charge_failed",
        });
      }
      const correlation = args.paymentSessionId && args.clientActionId
        ? buildSavedCardPendingHandoff({
          paymentSessionId: args.paymentSessionId,
          clientActionId: args.clientActionId,
          providerOrderId: args.orderId,
          clientState: preserveCard ? "PAYMENT_FAILED" : "DECLINED",
          declineReason,
        })
        : {};
      return new Response(JSON.stringify({
        error: humanizeRevolutPreauthCustomerError(
          preserveCard
            ? "Payment couldn’t be completed. Please try again in a moment."
            : (declineReason ?? "Payment failed"),
        ),
        code: preserveCard ? "payment_failed" : "card_declined",
        charge_state: "no_charge",
        client_state: preserveCard ? "PAYMENT_FAILED" : "DECLINED",
        terminal: true,
        preserve_saved_card: preserveCard,
        retry_after_ms: SAVED_CARD_TERMINAL_FAILURE_THROTTLE_MS,
        throttle_ms: SAVED_CARD_TERMINAL_FAILURE_THROTTLE_MS,
        no_new_order: true,
        ...correlation,
        // Override pending-shaped flags from handoff helper.
        saved_card_pending: false,
      }), {
        headers: { ...args.corsHeaders, "Content-Type": "application/json" },
        status: 402,
      });
    }
    args.logStep("Revolut saved-card payment still settling", {
      orderId: args.orderId,
      paymentState: resolved.paymentState,
      paymentSessionId: args.paymentSessionId ?? null,
      clientActionId: args.clientActionId ?? null,
    });
    // Return 200 processing handoff with stable IDs so TRY AGAIN can reconcile
    // the same session/order — never mint a new client_action_id blindly.
    if (args.paymentSessionId && args.clientActionId) {
      const handoff = buildSavedCardPendingHandoff({
        paymentSessionId: args.paymentSessionId,
        clientActionId: args.clientActionId,
        providerOrderId: args.orderId,
        clientState: "PAYMENT_PROCESSING",
      });
      return jsonResponseWithPreauthTiming({
        success: true,
        provider: "revolut",
        status: "payment_processing",
        saved_card_flow: true,
        requires_3ds: false,
        error: humanizeRevolutPreauthCustomerError(
          "Saved card payment is still processing. Please try again in a moment.",
        ),
        ...handoff,
      }, args.corsHeaders, 200, args.edgeTiming);
    }
    return jsonResponseWithPreauthTiming({
      error: humanizeRevolutPreauthCustomerError(
        "Saved card payment is still processing. Please try again in a moment.",
      ),
      code: "saved_card_pending",
      charge_state: "no_charge",
      client_state: "PAYMENT_PROCESSING",
      provider_order_id: args.orderId,
      payment_intent_id: args.orderId,
      payment_session_id: args.paymentSessionId ?? null,
      client_action_id: args.clientActionId ?? null,
    }, args.corsHeaders, 409, args.edgeTiming);
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : String(err);
    const preserveCard = isTechnicalDeclineReason(errMessage);
    args.logStep("Revolut saved-card preauth failed", {
      orderId: args.orderId,
      platformPaymentMethodId: args.platformPaymentMethodId,
      providerPaymentMethodId: tokenRow.provider_payment_method_id,
      error: errMessage,
      preserveSavedCard: preserveCard,
    });
    if (args.clientActionId || args.paymentSessionId) {
      await markPaymentSessionFailed(args.supabase, {
        clientActionId: args.clientActionId ?? null,
        providerOrderId: args.orderId,
        failureReason: `REVOLUT_SAVED_CARD_EXCEPTION:${errMessage}`.slice(0, 500),
      }).catch(() => {});
    }
    if (!preserveCard) {
      await invalidateRevolutProviderToken(args.supabase, {
        userId: args.userId,
        platformPaymentMethodId: args.platformPaymentMethodId,
        orderId: args.orderId,
        reason: errMessage,
      });
    }
    return new Response(JSON.stringify({
      error: humanizeRevolutPreauthCustomerError(errMessage || "Saved card payment failed"),
      code: "saved_card_charge_failed",
      charge_state: "no_charge",
      provider_error: errMessage,
      client_state: "PAYMENT_FAILED",
      terminal: true,
      preserve_saved_card: preserveCard,
      retry_after_ms: SAVED_CARD_TERMINAL_FAILURE_THROTTLE_MS,
      payment_session_id: args.paymentSessionId ?? null,
      client_action_id: args.clientActionId ?? null,
      provider_order_id: args.orderId,
      no_new_order: true,
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
  // Uber/Bolt-class Book: do not burn ~7s of Edge sleep here. Client confirm
  // ticks finish AUTHORISED / 3DS when settle is still in flight.
  const pollDelaysMs = [0, 100, 250, 500];
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
  waterfallFragment?: { booking_waterfall: import("./bookingWaterfallSSOT.ts").BookingWaterfallServerStepInput[] };
  holdStartedAt?: number;
  edgeTiming?: PreauthEdgeTiming | null;
}): Response {
  return jsonResponseWithPreauthTiming({
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
  }, args.corsHeaders, 200, args.edgeTiming);
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
  waterfallFragment?: { booking_waterfall: import("./bookingWaterfallSSOT.ts").BookingWaterfallServerStepInput[] };
  holdStartedAt?: number;
  edgeTiming?: PreauthEdgeTiming | null;
}): Response {
  const token = args.order.token ?? null;
  if (!token) {
    return jsonResponseWithPreauthTiming({
      error: humanizeRevolutPreauthCustomerError("Revolut checkout token missing from order response"),
      code: "PAYMENT_SETUP_FAILED",
      charge_state: "no_charge",
    }, args.corsHeaders, 500, args.edgeTiming);
  }

  const savedCardVerify = args.savedCardContext === true;
  const blockingReason = args.savedCardBlockingReason
    ?? (savedCardVerify ? "provider_token_missing_in_db" : null);

  return jsonResponseWithPreauthTiming({
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
  }, args.corsHeaders, 200, args.edgeTiming);
}
