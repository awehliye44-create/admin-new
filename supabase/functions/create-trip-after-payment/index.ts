import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  buildMinimalTripInsertRow,
  type BookingCommitBody,
} from "../_shared/bookingSSOT.ts";
import { resolveScheduledDispatchConfig } from "../_shared/scheduledDispatchConfig.ts";
import { buildBookingPostCommitTasks } from "../_shared/bookingPostCommit.ts";
import { verifyRevolutHoldForTripCreateFast } from "../_shared/bookingPaymentVerifyFast.ts";
import {
  assertCanBookRide,
  logPassengerBookingBlocked,
  passengerNotEligibleResponse,
} from "../_shared/passengerEligibility.ts";
import {
  BOOKING_FAILED_NO_TRIP_MESSAGE,
} from "../_shared/bookingFailurePreauthReversal.ts";
import {
  assertGatewayExecutable,
  checkServiceAreaGateway,
  gatewayNotConfiguredResponse,
} from "../_shared/paymentGatewayGuard.ts";
import {
  type RevolutOrder,
} from "../_shared/revolutOrders.ts";
import { resolveRevolutMerchantContext } from "../_shared/revolutMerchantContext.ts";
import { humanizeRevolutBookingCustomerError } from "../_shared/revolutCustomerError.ts";
import {
  gatePaymentSessionForTripCreate,
  loadPaymentSession,
  markPaymentSessionAuthorised,
  markPaymentSessionOrphaned,
  markPaymentSessionTripCreated,
  PAYMENT_ORPHANED_CUSTOMER_MESSAGE,
} from "../_shared/paymentSessionSSOT.ts";
import { buildBookingWaterfallMilestoneReport } from "../../../shared/bookingWaterfallSSOT.ts";
import { digitalOnlyPaymentMethodFlags } from "../../../shared/digitalFinanceSSOT.ts";
import { isAuthorisedHoldSessionStatus } from "../../../shared/revolutPaymentHoldSSOT.ts";
import { serveWithEdgeTiming } from "../_shared/edgeFunctionTiming.ts";
import { createBookingWaterfallCollector } from "../_shared/bookingWaterfallTelemetry.ts";
import { releaseHoldForPaymentSession } from "../_shared/holdReleaseSSOT.ts";
import {
  buildTripFinancialModelSnapshot,
  classifyServiceAreaFinancialPairing,
  INVALID_CONFIGURATION,
  shouldSkipPlatformPreauthForCommissionWallet,
  type ServiceAreaCommissionWalletConfig,
} from "../_shared/commissionWalletSSOT.ts";

declare const EdgeRuntime: { waitUntil: (promise: Promise<unknown>) => void };

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const log = (step: string, details?: unknown) => {
  const d = details ? ` - ${JSON.stringify(details)}` : "";
  console.log(`[CREATE-TRIP-AFTER-PAYMENT] ${step}${d}`);
};

const error = (message: string, status: number) =>
  new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

type BookingFailureContext = {
  userId: string;
  customerId?: string | null;
  clientActionId?: string | null;
  serviceAreaId?: string | null;
  failureStage: string;
  failureReason: string;
};

async function failBookingAfterAuthorizedPayment(
  supabase: ReturnType<typeof createClient>,
  order: RevolutOrder | null,
  ctx: BookingFailureContext,
  httpStatus: number,
  customerMessage: string = BOOKING_FAILED_NO_TRIP_MESSAGE,
  extraBody?: Record<string, unknown>,
): Promise<Response> {
  if (order) {
    return failBookingAfterAuthorizedRevolutOrder(
      supabase,
      order,
      ctx,
      httpStatus,
      customerMessage,
      extraBody,
    );
  }
  return new Response(JSON.stringify({
    error: customerMessage,
    code: "BOOKING_FAILED",
    ...extraBody,
  }), {
    status: httpStatus,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function failBookingAfterAuthorizedRevolutOrder(
  supabase: ReturnType<typeof createClient>,
  order: RevolutOrder,
  ctx: {
    userId: string;
    customerId?: string | null;
    clientActionId?: string | null;
    serviceAreaId?: string | null;
    failureStage: string;
    failureReason: string;
    bookingSnapshot?: Record<string, unknown>;
  },
  httpStatus: number,
  customerMessage: string = BOOKING_FAILED_NO_TRIP_MESSAGE,
  extraBody?: Record<string, unknown>,
): Promise<Response> {
  let reversalStatus = "none";
  try {
    const release = await releaseHoldForPaymentSession(supabase, {
      providerOrderId: order.id,
      clientActionId: ctx.clientActionId ?? null,
      terminalReason: ctx.failureReason || "booking_failed_no_trip",
      source: "create-trip-after-payment",
      idempotencyKey: `ctap_fail_${ctx.clientActionId ?? order.id}`,
    });
    reversalStatus =
      release.released || release.idempotent || release.status === "released"
        ? "cancelled"
        : "failed";
    if (reversalStatus === "failed") {
      console.error("[CREATE-TRIP-AFTER-PAYMENT] Revolut session release failed", {
        order_id: order.id,
        status: release.status,
        error: release.error ?? null,
      });
    }
  } catch (err) {
    console.error("[CREATE-TRIP-AFTER-PAYMENT] Revolut cancel failed", {
      order_id: order.id,
      error: err instanceof Error ? err.message : String(err),
    });
    reversalStatus = "failed";
  }

  if (reversalStatus !== "cancelled") {
    await markPaymentSessionOrphaned(supabase, {
      clientActionId: ctx.clientActionId ?? null,
      providerOrderId: order.id,
      userId: ctx.userId,
      customerId: ctx.customerId ?? null,
      serviceAreaId: ctx.serviceAreaId ?? null,
      authorisedAmountPence: Number(order.amount ?? 0),
      failureReason: ctx.failureReason,
      failureStage: ctx.failureStage,
      bookingSnapshot: ctx.bookingSnapshot,
    });
    log("Booking failed after Revolut auth — payment orphaned for recovery", {
      provider_order_id: order.id,
      failure_stage: ctx.failureStage,
      reversal_status: reversalStatus,
    });
    return new Response(JSON.stringify({
      error: PAYMENT_ORPHANED_CUSTOMER_MESSAGE,
      code: "PAYMENT_ORPHANED",
      charge_state: "authorised_requires_recovery",
      payment_intent_id: order.id,
      reversal_status: reversalStatus,
      failure_stage: ctx.failureStage,
      failure_reason: ctx.failureReason,
      ...extraBody,
    }), {
      status: httpStatus,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  log("Booking failed after Revolut auth — preauth reversed", {
    provider_order_id: order.id,
    failure_stage: ctx.failureStage,
    reversal_status: reversalStatus,
  });

  await supabase.from("admin_payment_audit").insert({
    action: "booking_failed_after_revolut_auth",
    provider: "revolut",
    provider_payment_id: order.id,
    metadata: {
      failure_stage: ctx.failureStage,
      failure_reason: ctx.failureReason,
      reversal_status: reversalStatus,
      client_action_id: ctx.clientActionId ?? null,
      customer_id: ctx.customerId ?? null,
      service_area_id: ctx.serviceAreaId ?? null,
    },
  }).then(({ error }) => {
    if (error) {
      console.error("[CREATE-TRIP-AFTER-PAYMENT] admin alert insert failed", error.message);
    }
  });

  return new Response(JSON.stringify({
    error: customerMessage,
    code: "BOOKING_FAILED_PREAUTH_REVERSED",
    charge_state: reversalStatus === "cancelled" ? "reversed" : "hold_reversal_pending",
    payment_intent_id: order.id,
    reversal_status: reversalStatus,
    ...extraBody,
  }), {
    status: httpStatus,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

type RequestBody = BookingCommitBody;

serveWithEdgeTiming("create-trip-after-payment", corsHeaders, async (req) => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");

  if (!supabaseAnonKey) {
    return new Response(JSON.stringify({ error: "SUPABASE_ANON_KEY not set" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false },
  });
  let verifiedRevolutOrder: RevolutOrder | null = null;
  let reversalContext: {
    userId: string;
    customerId: string | null;
    clientActionId: string | null;
    serviceAreaId: string | null;
  } | null = null;

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body: RequestBody = await req.json();
    log("Request", { pi: body.payment_intent_id, clientActionId: body.client_action_id });
    const bookingWaterfall = createBookingWaterfallCollector({
      client_action_id: body.client_action_id ?? null,
    });

    const internalFinalizeSecret = req.headers.get("x-onecab-internal-finalize");
    const configuredInternalSecret = Deno.env.get("ONECAB_INTERNAL_FINALIZE_SECRET");
    const isInternalFinalize = Boolean(
      internalFinalizeSecret
      && configuredInternalSecret
      && internalFinalizeSecret === configuredInternalSecret
      && body.internal_user_id,
    );

    let user: { id: string };
    if (isInternalFinalize) {
      if (authHeader.replace("Bearer ", "") !== supabaseServiceKey) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      user = { id: body.internal_user_id! };
      log("Internal finalize authenticated", { userId: user.id });
    } else {
      const anonClient = createClient(supabaseUrl, supabaseAnonKey, {
        global: { headers: { Authorization: authHeader } },
        auth: { persistSession: false },
      });
      const token = authHeader.replace("Bearer ", "");
      const { data: claimsData, error: claimsError } = await anonClient.auth.getClaims(token);
      if (claimsError || !claimsData?.claims) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      user = { id: claimsData.claims.sub as string };
      log("User authenticated", { userId: user.id });
    }

    const bookingEligibility = await assertCanBookRide(supabase, user.id);
    if (!bookingEligibility.allowed) {
      logPassengerBookingBlocked("create-trip-after-payment", user.id, bookingEligibility);
      return passengerNotEligibleResponse(bookingEligibility, corsHeaders);
    }

    if (!body.client_action_id) {
      return new Response(JSON.stringify({ error: "client_action_id is required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!body.pickup?.address || !body.dropoff?.address) {
      return new Response(JSON.stringify({ error: "pickup and dropoff are required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // DEV NOTE: Cash payment temporarily allowed for development/testing.
    // For production digital-only platform, uncomment the block below.
    /*
    const requestedMethod = (body.payment_method || "card").toLowerCase();
    if (requestedMethod === "cash") {
      log("REJECTED — cash not supported (digital-only platform)");
      return new Response(JSON.stringify({
        error: "Cash payment is no longer supported. ONECAB is a digital-only platform.",
        code: "CASH_NOT_SUPPORTED",
      }), { status: 410, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    */

    if (!body.service_area_id) {
      return new Response(JSON.stringify({
        error: "service_area_id is required for new bookings",
        error_code: "SERVICE_AREA_REQUIRED",
      }), {
        status: 422,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: saFinancialRow, error: saFinancialErr } = await supabase
      .from("service_areas")
      .select(
        "id, financial_model, commission_wallet_enabled, customer_payment_policy, commission_wallet_currency, region_id",
      )
      .eq("id", body.service_area_id)
      .maybeSingle();
    if (saFinancialErr) {
      return new Response(JSON.stringify({ error: saFinancialErr.message }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const saFinancialConfig: ServiceAreaCommissionWalletConfig = {
      financial_model: saFinancialRow?.financial_model,
      commission_wallet_enabled: saFinancialRow?.commission_wallet_enabled,
      customer_payment_policy: saFinancialRow?.customer_payment_policy,
      commission_wallet_currency: saFinancialRow?.commission_wallet_currency,
    };
    const saPairing = classifyServiceAreaFinancialPairing(saFinancialConfig);
    if (!saPairing.ok) {
      return new Response(JSON.stringify({
        error: saPairing.error,
        error_code: INVALID_CONFIGURATION,
        code: INVALID_CONFIGURATION,
      }), {
        status: 422,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const skipPlatformPreauth = shouldSkipPlatformPreauthForCommissionWallet(saFinancialConfig);
    const financialModelSnapshot = buildTripFinancialModelSnapshot({
      serviceAreaId: body.service_area_id,
      regionId: saFinancialRow?.region_id ?? null,
      currency: String(saFinancialRow?.commission_wallet_currency || "GBP").toUpperCase(),
      commissionRateBps: 0,
      config: saFinancialConfig,
    });
    if (skipPlatformPreauth && body.payment_intent_id) {
      return new Response(JSON.stringify({
        error: "Payment Session is forbidden for DRIVER_COLLECTED_COMMISSION_WALLET",
        error_code: "FINANCIAL_MODEL_VIOLATION",
        code: "FINANCIAL_MODEL_VIOLATION",
      }), {
        status: 409,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!skipPlatformPreauth && !body.payment_intent_id) {
      return new Response(JSON.stringify({ error: "payment_intent_id is required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!skipPlatformPreauth) {
      const customerGatewayCheck = assertGatewayExecutable(
        await checkServiceAreaGateway(supabase, body.service_area_id, "customer"),
      );
      if (!customerGatewayCheck.ok) {
        return gatewayNotConfiguredResponse(customerGatewayCheck, corsHeaders);
      }

      if (String(body.payment_intent_id ?? "").trim().startsWith("pi_")) {
        log("REJECTED — invalid provider order id shape", {
          service_area_id: body.service_area_id,
        });
        return new Response(JSON.stringify({
          error: "Invalid payment order. Please complete Revolut checkout and try again.",
          error_code: "INVALID_PROVIDER_ORDER",
          message: "Invalid payment order. Please complete Revolut checkout and try again.",
        }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (customerGatewayCheck.provider !== "revolut") {
        return new Response(JSON.stringify({
          error: "Card payments require Revolut.",
          error_code: "PAYMENT_PROVIDER_UNAVAILABLE",
          message: "Card payments require Revolut.",
        }), {
          status: 410,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    const ctapStartedAt = Date.now();
    bookingWaterfall.recordStep({
      step: "trip_inserted",
      start_time_ms: ctapStartedAt,
      finish_time_ms: ctapStartedAt,
      source: "create-trip-after-payment/index.ts:ctap_start",
      blocking_dependency: "revolut_authorised",
      metadata: { phase: "ctap_start" },
    });

    const paymentSessionPromise = skipPlatformPreauth
      ? Promise.resolve(null)
      : (body.client_action_id
        ? loadPaymentSession(supabase, { clientActionId: body.client_action_id })
        : Promise.resolve(null));

    const [existingTripsRes, existingTripByPaymentRes, paymentRes, customerRowsRes, saRpcRes, paymentSessionRes] =
      await Promise.allSettled([
      supabase
        .from("trips")
        .select("id, trip_code, status")
        .eq("client_action_id", body.client_action_id)
        .limit(1),
      skipPlatformPreauth || !body.payment_intent_id
        ? Promise.resolve({ data: [] as { id: string; trip_code: string; status: string }[] })
        : supabase
          .from("trips")
          .select("id, trip_code, status")
          .eq("provider_order_id", body.payment_intent_id)
          .limit(1),
      skipPlatformPreauth
        ? Promise.resolve({ ok: true as const, skipped: true as const, order: null, reason: null })
        : paymentSessionPromise.then((session) => verifyRevolutHoldForTripCreateFast(supabase, {
          orderId: body.payment_intent_id!,
          clientActionId: body.client_action_id,
          preloadedSession: session,
        })),
      // 8. Customer record
      supabase.from("customers").select("id, first_name, last_name, phone").eq("user_id", user.id).limit(1),
      // 9. Service area RPC
      supabase.rpc("find_service_area_by_location", {
        p_lat: body.pickup.lat || 0,
        p_lng: body.pickup.lng || 0,
      }),
      paymentSessionPromise,
    ]);

    // 3. Idempotency short-circuit (client_action_id or payment ref)
    const idempotentTrip =
      (existingTripsRes.status === "fulfilled" ? existingTripsRes.value.data?.[0] : null)
      ?? (existingTripByPaymentRes.status === "fulfilled" ? existingTripByPaymentRes.value.data?.[0] : null);
    if (idempotentTrip) {
      log("Idempotent — trip already exists", {
        tripId: idempotentTrip.id,
        by: existingTripsRes.status === "fulfilled" && existingTripsRes.value.data?.[0]
          ? "client_action_id"
          : "payment_ref",
      });
      return new Response(JSON.stringify({
        success: true,
        ride_id: idempotentTrip.id,
        trip_code: idempotentTrip.trip_code,
        trip_reference: idempotentTrip.trip_code ?? null,
        status: idempotentTrip.status,
        idempotent: true,
      }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    reversalContext = {
      userId: user.id,
      customerId: null,
      clientActionId: body.client_action_id ?? null,
      serviceAreaId: body.service_area_id ?? null,
    };

    let preauthAmount = 0;
    let preauthMetadata: Record<string, string> = {};
    let paymentSessionId: string | null = null;
    let paymentRefId = "";

    if (!skipPlatformPreauth) {
    // 4. Payment validation
    if (paymentRes.status === "rejected") {
      log("REJECTED — payment retrieve failed", { error: String(paymentRes.reason) });
      return new Response(JSON.stringify({ error: "Payment verification failed. Please try again." }), {
        status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const confirmation = paymentRes.value as Awaited<
      ReturnType<typeof verifyRevolutHoldForTripCreateFast>
    >;
    if (!confirmation.ok) {
      log("REJECTED — Revolut payment not confirmed", {
        status: confirmation.order?.state,
        reason: confirmation.reason,
      });
      return new Response(JSON.stringify({
        error: humanizeRevolutBookingCustomerError(confirmation.reason),
        payment_status: confirmation.order?.state ?? null,
        code: "PAYMENT_NOT_CONFIRMED",
      }), { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const order = confirmation.order;
    const preloadedSession = paymentSessionRes.status === "fulfilled"
      ? paymentSessionRes.value
      : null;
    const sessionAlreadyAuthorised = preloadedSession
      && isAuthorisedHoldSessionStatus(String(preloadedSession.status ?? ""));
    if (!sessionAlreadyAuthorised) {
      await markPaymentSessionAuthorised(supabase, {
        providerOrderId: order.id,
        clientActionId: body.client_action_id ?? null,
      });
    }
    log("Revolut order confirmed for booking", { status: order.state, amount: order.amount });

    const orderClientActionId = order.metadata?.client_action_id;
    if (orderClientActionId && orderClientActionId !== body.client_action_id) {
      log("REJECTED — Revolut order client_action_id mismatch", {
        orderClientActionId,
        clientActionId: body.client_action_id,
      });
      return new Response(JSON.stringify({
        error: "Payment does not belong to this booking",
      }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const orderCustomerUserId = order.metadata?.customer_user_id;
    if (orderCustomerUserId && orderCustomerUserId !== user.id) {
      log("REJECTED — Revolut order does not belong to user", { orderCustomerUserId, userId: user.id });
      return new Response(JSON.stringify({ error: "Payment does not belong to this user" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    verifiedRevolutOrder = order;
    preauthAmount = Number(order.amount ?? 0);
    preauthMetadata = (order.metadata ?? {}) as Record<string, string>;

    // 7. Verify hold covers payable fare (post-discount). Prefer session fare_snapshot.
    const sessionSnapForGate = (preloadedSession?.fare_snapshot &&
        typeof preloadedSession.fare_snapshot === "object")
      ? preloadedSession.fare_snapshot as Record<string, unknown>
      : null;
    const sessionPayablePence = (() => {
      if (!sessionSnapForGate) return 0;
      for (const key of [
        "final_fare_pence",
        "estimated_total_pence",
        "final_customer_fare_pence",
        "final_payable_fare_pence",
        "authorised_amount_pence",
      ]) {
        const n = Math.round(Number(sessionSnapForGate[key] ?? 0));
        if (Number.isFinite(n) && n > 0) return n;
      }
      const sessionAuth = Math.round(Number(
        (preloadedSession as { authorised_amount_pence?: number } | null)
          ?.authorised_amount_pence ?? 0,
      ));
      return sessionAuth > 0 ? sessionAuth : 0;
    })();
    const bodyPayablePence = Math.round(body.estimated_fare * 100);
    const payableFarePence = sessionPayablePence > 0 ? sessionPayablePence : bodyPayablePence;
    const minRequiredHoldPence = payableFarePence;
    if (preauthAmount < minRequiredHoldPence) {
      log("REJECTED — preauth hold below payable fare", {
        preauthAmount,
        payableFarePence,
        sessionPayablePence,
        bodyPayablePence,
        minRequiredHoldPence,
        original_estimated_fare: body.original_estimated_fare ?? null,
      });
      return failBookingAfterAuthorizedRevolutOrder(
        supabase,
        verifiedRevolutOrder!,
        {
          ...reversalContext,
          failureStage: "amount_insufficient",
          failureReason: `preauth_amount_${preauthAmount}_lt_payable_${minRequiredHoldPence}`,
        },
        402,
        BOOKING_FAILED_NO_TRIP_MESSAGE,
        { payment_status: verifiedRevolutOrder!.state, code: "PAYMENT_AUTHORISATION_INSUFFICIENT" },
      );
    }
    log("Payment verified ✓", {
      provider: "revolut",
      amount: preauthAmount,
      payable_fare_pence: payableFarePence,
      session_payable_pence: sessionPayablePence || null,
    });

    if (body.client_action_id) {
      const sessionGate = gatePaymentSessionForTripCreate(preloadedSession);
      if (!sessionGate.ok) {
        log("REJECTED — no authorised payment session for trip create", sessionGate);
        if (verifiedRevolutOrder) {
          return failBookingAfterAuthorizedRevolutOrder(
            supabase,
            verifiedRevolutOrder,
            {
              ...reversalContext!,
              failureStage: "payment_session_not_authorised",
              failureReason: sessionGate.reason,
            },
            402,
            BOOKING_FAILED_NO_TRIP_MESSAGE,
          );
        }
        return new Response(JSON.stringify({
          error: "Payment hold not confirmed. No trip created.",
          code: "PAYMENT_SESSION_NOT_AUTHORISED",
        }), { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      if (sessionGate.recoveryRetry) {
        await markPaymentSessionAuthorised(supabase, {
          providerOrderId: verifiedRevolutOrder!.id,
          clientActionId: body.client_action_id ?? null,
        });
        log("Orphan payment session reopened for CTAP recovery retry", {
          client_action_id: body.client_action_id,
          provider_order_id: verifiedRevolutOrder!.id,
        });
      }
      paymentSessionId = sessionGate.sessionId;
    }

    paymentRefId = verifiedRevolutOrder!.id;
    } else {
      log("Driver-Collected — skip Payment Session and platform capture");
    }

    // 8. Customer record — trips.passenger_id FK references customers.id (not auth.users.id).
    let customerRow =
      customerRowsRes.status === "fulfilled" ? customerRowsRes.value.data?.[0] ?? null : null;
    let customerId = (customerRow as { id?: string } | null)?.id ?? null;
    if (!customerId) {
      const { data: customerRetry } = await supabase
        .from("customers")
        .select("id, first_name, last_name, phone")
        .eq("user_id", user.id)
        .limit(1)
        .maybeSingle();
      customerRow = customerRetry;
      customerId = customerRetry?.id ?? null;
    }
    if (!customerId) {
      log("REJECTED — customer profile missing for trip insert", { userId: user.id });
      return failBookingAfterAuthorizedPayment(
        supabase,
        verifiedRevolutOrder,
        {
          ...reversalContext!,
          failureStage: "customer_profile_missing",
          failureReason: "customers_row_missing",
        },
        422,
        "Could not complete booking. Please try again.",
      );
    }
    reversalContext.customerId = customerId;

    // P0: one passenger → max one live IMMEDIATE trip. Scheduled coexistence allowed.
    const isScheduledBooking =
      String(body.when ?? "").toUpperCase() === "SCHEDULED" ||
      Boolean(body.scheduled_at);

    /** Webhook/CTAP race: live trip for THIS booking must be success, not 409. */
    const sameBookingTripResponse = async (
      tripId: string,
      reason: string,
    ): Promise<Response | null> => {
      const { data: liveTrip } = await supabase
        .from("trips")
        .select("id, trip_code, status, client_action_id, provider_order_id")
        .eq("id", tripId)
        .maybeSingle();
      if (!liveTrip) return null;
      const sameClientAction =
        Boolean(body.client_action_id) &&
        liveTrip.client_action_id === body.client_action_id;
      const sameProviderOrder =
        Boolean(body.payment_intent_id) &&
        liveTrip.provider_order_id === body.payment_intent_id;
      if (!sameClientAction && !sameProviderOrder) return null;
      log("Idempotent — live trip is this booking", {
        tripId: liveTrip.id,
        reason,
        by: sameClientAction ? "client_action_id" : "provider_order_id",
      });
      return new Response(JSON.stringify({
        success: true,
        ride_id: liveTrip.id,
        trip_code: liveTrip.trip_code,
        trip_reference: liveTrip.trip_code ?? null,
        status: liveTrip.status,
        idempotent: true,
      }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    };

    if (!isScheduledBooking) {
      const { data: liveTripId, error: liveTripErr } = await supabase.rpc(
        "passenger_has_live_immediate_trip",
        { p_passenger_id: customerId, p_exclude_trip_id: null },
      );
      if (liveTripErr) {
        log("live_immediate_trip_check_failed", { error: liveTripErr.message });
      } else if (liveTripId) {
        const sameBooking = await sameBookingTripResponse(
          String(liveTripId),
          "live_trip_precheck",
        );
        if (sameBooking) return sameBooking;

        // Idempotent lookup raced ahead of webhook insert — re-check keys.
        if (body.client_action_id) {
          const { data: byCa } = await supabase
            .from("trips")
            .select("id, trip_code, status")
            .eq("client_action_id", body.client_action_id)
            .limit(1)
            .maybeSingle();
          if (byCa) {
            log("Idempotent — trip appeared after live precheck", {
              tripId: byCa.id,
              by: "client_action_id",
            });
            return new Response(JSON.stringify({
              success: true,
              ride_id: byCa.id,
              trip_code: byCa.trip_code,
              trip_reference: byCa.trip_code ?? null,
              status: byCa.status,
              idempotent: true,
            }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
          }
        }

        log("REJECTED — customer already has live immediate trip", {
          existing_trip_id: liveTripId,
          client_action_id: body.client_action_id,
        });
        if (paymentSessionId) {
          await supabase
            .from("payment_sessions")
            .update({
              status: "payment_orphaned",
              updated_at: new Date().toISOString(),
              metadata: {
                orphan_reason: "CUSTOMER_ALREADY_HAS_ACTIVE_TRIP",
                existing_trip_id: liveTripId,
                orphaned_at: new Date().toISOString(),
                orphaned_by: "create-trip-after-payment",
                release_recommended: true,
                never_capture: true,
              },
            })
            .eq("id", paymentSessionId)
            .is("trip_id", null);
        }
        return new Response(JSON.stringify({
          success: false,
          error: "You already have an active trip.",
          code: "CUSTOMER_ALREADY_HAS_ACTIVE_TRIP",
          existing_trip_id: liveTripId,
        }), { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
    }

    // 9. Service area resolution
    let serviceAreaId: string | null = null;
    let serviceAreaCode: string | null = null;
    let regionId: string | null = null;
    let regionCurrencyCode: string | null = null;
    let regionDistanceUnit: string | null = null;

    try {
      if (saRpcRes.status === "fulfilled") {
        serviceAreaId = saRpcRes.value.data ?? null;
      }
      if (body.service_area_id && serviceAreaId && body.service_area_id !== serviceAreaId) {
        log("Ignoring client service_area_id mismatch", {
          client: body.service_area_id,
          resolved: serviceAreaId,
          pickup: { lat: body.pickup.lat, lng: body.pickup.lng },
        });
      }
      if (serviceAreaId) {
        const { data: saDetails } = await supabase
          .from("service_areas")
          .select("code, region_id, regions!inner(currency_code, distance_unit)")
          .eq("id", serviceAreaId)
          .single();
        serviceAreaCode = saDetails?.code || null;
        regionId = saDetails?.region_id || null;
        const region = saDetails?.regions as Record<string, unknown> | undefined;
        if (region?.currency_code) regionCurrencyCode = region.currency_code as string;
        if (region?.distance_unit) regionDistanceUnit = region.distance_unit as string;
        log("Region resolved", { regionId, currencyCode: regionCurrencyCode, distanceUnit: regionDistanceUnit });
      }
    } catch (e) {
      log("Service area lookup warning", { error: String(e) });
    }

    // HARD GATE: never create a trip outside a real service area.
    if (!serviceAreaId) {
      log("REJECTED — pickup outside any active service area", {
        pickup: { lat: body.pickup.lat, lng: body.pickup.lng },
      });
      return failBookingAfterAuthorizedPayment(
        supabase,
        verifiedRevolutOrder,
        {
          ...reversalContext,
          failureStage: "service_area_unavailable",
          failureReason: "pickup_outside_service_area",
        },
        400,
        "Service not available at this pickup location.",
      );
    }
    reversalContext.serviceAreaId = serviceAreaId;

    // 9b. Validate payment method against service area config
    if (serviceAreaId && body.payment_method) {
      const { data: pmConfig } = await supabase
        .from("service_area_payment_methods")
        .select("card_enabled, wallet_enabled, apple_pay_enabled, google_pay_enabled")
        .eq("service_area_id", serviceAreaId)
        .maybeSingle();

      if (pmConfig) {
        const digitalFlags = digitalOnlyPaymentMethodFlags();
        const methodAllowed: Record<string, boolean> = {
          cash: false,
          card: pmConfig.card_enabled ?? digitalFlags.card,
          wallet: pmConfig.wallet_enabled ?? digitalFlags.wallet,
          apple_pay: pmConfig.apple_pay_enabled ?? digitalFlags.applePay,
          google_pay: pmConfig.google_pay_enabled ?? digitalFlags.googlePay,
        };
        const selected = body.payment_method;
        if (
          selected in methodAllowed
          && !methodAllowed[selected]
          && !(skipPlatformPreauth && (selected === "cash" || selected === "card"))
        ) {
          log("REJECTED — payment method not allowed for service area", { selected, serviceAreaId });
          return failBookingAfterAuthorizedPayment(
            supabase,
            verifiedRevolutOrder,
            {
              ...reversalContext,
              failureStage: "payment_method_not_allowed",
              failureReason: `method_${selected}_disabled`,
            },
            400,
            BOOKING_FAILED_NO_TRIP_MESSAGE,
          );
        }
      }
    }

    // Validate Region configuration
    if (!regionCurrencyCode || !regionDistanceUnit) {
      log("Region missing currency or distance unit", { serviceAreaId, regionCurrencyCode, regionDistanceUnit });
      return failBookingAfterAuthorizedPayment(
        supabase,
        verifiedRevolutOrder,
        {
          ...reversalContext,
          failureStage: "region_config_incomplete",
          failureReason: "missing_currency_or_distance_unit",
        },
        400,
        BOOKING_FAILED_NO_TRIP_MESSAGE,
      );
    }

    // 10. Build trip data
    const isScheduled = body.when === "SCHEDULED";
    const driverIdUuidRe =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const preAssignedDriverId =
      !isScheduled && body.pre_assigned_driver_id &&
        driverIdUuidRe.test(String(body.pre_assigned_driver_id).trim())
        ? String(body.pre_assigned_driver_id).trim()
        : null;

    const intermediateStops = body.stops || [];
    const totalStops = 1 + intermediateStops.length + 1;

    // Never create a trip without a valid fare
    if (!body.estimated_fare || body.estimated_fare <= 0) {
      console.error("Rejected — no valid fare provided:", body.estimated_fare);
      return failBookingAfterAuthorizedPayment(
        supabase,
        verifiedRevolutOrder,
        {
          ...reversalContext,
          failureStage: "invalid_fare",
          failureReason: "estimated_fare_missing_or_zero",
        },
        400,
        BOOKING_FAILED_NO_TRIP_MESSAGE,
      );
    }

    const loadedPaymentSession = paymentSessionRes.status === "fulfilled"
      ? paymentSessionRes.value
      : null;
    const sessionFareSnapshot = (loadedPaymentSession?.fare_snapshot as Record<string, unknown> | undefined)
      ?? null;

    const grossFarePence = body.original_estimated_fare != null && body.original_estimated_fare > 0
      ? Math.round(body.original_estimated_fare * 100)
      : Math.round(body.estimated_fare * 100);
    const finalFarePence = Math.round(body.estimated_fare * 100);

    // Admin Scheduled Rides Configuration (Dispatch tab) — never hardcode −30/−10.
    let scheduledDispatchConfig = resolveScheduledDispatchConfig(null);
    if (body.when === "SCHEDULED") {
      const { data: globalCfg } = await supabase
        .from("global_dispatch_settings")
        .select(
          "enable_scheduled_to_urgent_conversion, scheduled_response_window_minutes, urgent_dispatch_trigger_minutes_before_pickup, locked_driver_response_minutes, max_driver_find_time_minutes, scheduled_urgent_card_label",
        )
        .eq("singleton", true)
        .maybeSingle();
      scheduledDispatchConfig = resolveScheduledDispatchConfig(globalCfg);
    }

    const tripData = buildMinimalTripInsertRow({
      body,
      customerId,
      customerProfile: customerRow
        ? {
          first_name: (customerRow as { first_name?: string | null }).first_name ?? null,
          last_name: (customerRow as { last_name?: string | null }).last_name ?? null,
          phone: (customerRow as { phone?: string | null }).phone ?? null,
        }
        : null,
      serviceAreaId,
      serviceAreaCode,
      regionId,
      regionCurrencyCode,
      regionDistanceUnit,
      paymentProvider: skipPlatformPreauth ? "driver_collected" : "revolut",
      paymentRefId,
      preauthAmountPence: preauthAmount,
      paymentSessionId: skipPlatformPreauth ? null : paymentSessionId,
      sessionFareSnapshot,
      requestReferer: req.headers.get("referer") ?? req.headers.get("referrer"),
      requestOrigin: req.headers.get("origin"),
      scheduledDispatchConfig,
      financialModelSnapshot,
    });

    if (preAssignedDriverId) {
      tripData.pre_assigned_driver_id = preAssignedDriverId;
      log("pre_assigned_driver_id set", { id: preAssignedDriverId });
    }

    log("Inserting trip (minimal SSOT commit)");
    bookingWaterfall.startStep("trip_inserted", "create-trip-after-payment/index.ts:trips.insert");

    const { data: insertedTrips, error: insertErr } = await supabase
      .from("trips")
      .insert(tripData)
      .select("id, trip_code, status")
      .single();

    if (insertErr) {
      // Check for duplicate
      if (insertErr.message?.includes("duplicate") || insertErr.message?.includes("client_action_id")) {
        const { data: retryTrips } = await supabase
          .from("trips")
          .select("id, trip_code, status")
          .eq("client_action_id", body.client_action_id)
          .limit(1);
        if (retryTrips?.[0]) {
          bookingWaterfall.completeStep(
            "trip_inserted",
            "create-trip-after-payment/index.ts:trips.insert(idempotent)",
            { trip_id: retryTrips[0].id, idempotent: true },
          );
          return new Response(JSON.stringify({
            success: true,
            ride_id: retryTrips[0].id,
            trip_code: retryTrips[0].trip_code,
            trip_reference: retryTrips[0].trip_code ?? null,
            status: retryTrips[0].status,
            idempotent: true,
            ...bookingWaterfall.toResponseFragment(),
          }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        // Concurrent finaliser won the one-live-immediate-trip unique index.
        if (
          !isScheduledBooking &&
          (insertErr.message?.includes("trips_one_live_immediate_per_passenger_uidx") ||
            insertErr.code === "23505")
        ) {
          const { data: existingLive } = await supabase.rpc(
            "passenger_has_live_immediate_trip",
            { p_passenger_id: customerId, p_exclude_trip_id: null },
          );
          if (existingLive) {
            const sameBooking = await sameBookingTripResponse(
              String(existingLive),
              "unique_violation",
            );
            if (sameBooking) return sameBooking;
          }
          // Same client_action_id may exist even if live RPC briefly lags.
          if (body.client_action_id) {
            const { data: byCa } = await supabase
              .from("trips")
              .select("id, trip_code, status")
              .eq("client_action_id", body.client_action_id)
              .limit(1)
              .maybeSingle();
            if (byCa) {
              return new Response(JSON.stringify({
                success: true,
                ride_id: byCa.id,
                trip_code: byCa.trip_code,
                trip_reference: byCa.trip_code ?? null,
                status: byCa.status,
                idempotent: true,
              }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
            }
          }
          if (paymentSessionId) {
            await supabase
              .from("payment_sessions")
              .update({
                status: "payment_orphaned",
                updated_at: new Date().toISOString(),
                metadata: {
                  orphan_reason: "CUSTOMER_ALREADY_HAS_ACTIVE_TRIP",
                  existing_trip_id: existingLive,
                  orphaned_at: new Date().toISOString(),
                  orphaned_by: "create-trip-after-payment_unique_violation",
                  release_recommended: true,
                  never_capture: true,
                },
              })
              .eq("id", paymentSessionId)
              .is("trip_id", null);
          }
          return new Response(JSON.stringify({
            success: false,
            error: "You already have an active trip.",
            code: "CUSTOMER_ALREADY_HAS_ACTIVE_TRIP",
            existing_trip_id: existingLive ?? null,
          }), { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
      }
      throw new Error(`Trip insert failed: ${insertErr.message}`);
    }

    const trip = insertedTrips;
    log("Trip created", { tripId: trip.id });
    bookingWaterfall.completeStep(
      "trip_inserted",
      "create-trip-after-payment/index.ts:trips.insert",
      { trip_id: trip.id },
    );

    const ctapResponseAt = Date.now();
    bookingWaterfall.recordStep({
      step: "trip_inserted",
      start_time_ms: ctapStartedAt,
      finish_time_ms: ctapResponseAt,
      source: "create-trip-after-payment/index.ts:ctap_response",
      blocking_dependency: "revolut_authorised",
      metadata: {
        phase: "ctap_response",
        ctap_duration_ms: ctapResponseAt - ctapStartedAt,
        trip_id: trip.id,
      },
    });

    const postInsertTasks = buildBookingPostCommitTasks({
      supabase,
      userId: user.id,
      customerId,
      body,
      tripId: trip.id,
      paymentRefId,
      paymentProvider: "revolut",
      preauthAmountPence: preauthAmount,
      grossFarePence,
      finalFarePence,
      paymentSessionId,
      serviceAreaId,
      regionId,
      regionCurrencyCode,
      regionDistanceUnit,
      isScheduled,
      preauthMetadata,
      bookingWaterfall,
      log,
    });

    EdgeRuntime.waitUntil(Promise.allSettled(postInsertTasks));

    if (!skipPlatformPreauth) {
      await markPaymentSessionTripCreated(supabase, {
        clientActionId: body.client_action_id,
        tripId: trip.id,
        providerOrderId: paymentRefId,
      });
    }

    const bookingMilestones = {
      ctap_start_ms: ctapStartedAt,
      trip_inserted_ms: ctapResponseAt,
      ctap_response_ms: ctapResponseAt,
      ctap_duration_ms: ctapResponseAt - ctapStartedAt,
    };
    const bookingWaterfallReport = buildBookingWaterfallMilestoneReport({
      milestones: bookingMilestones,
    });

    return new Response(JSON.stringify({
      success: true,
      ride_id: trip.id,
      trip_code: trip.trip_code,
      trip_reference: trip.trip_code ?? null,
      trip_number: null,
      status: trip.status,
      dispatch_mode: isScheduled ? "scheduled" : "instant",
      total_stops: totalStops,
      payment_verified: true,
      dispatch_deferred: !isScheduled,
      booking_milestones: bookingMilestones,
      booking_waterfall_report: bookingWaterfallReport,
      ...bookingWaterfall.toResponseFragment(),
    }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    log("ERROR", {
      message,
      payment_intent_id: verifiedRevolutOrder?.id ?? null,
    });

    if (reversalContext && verifiedRevolutOrder) {
      return failBookingAfterAuthorizedRevolutOrder(
        supabase,
        verifiedRevolutOrder,
        {
          ...reversalContext,
          failureStage: "unhandled_exception",
          failureReason: message.slice(0, 500),
        },
        500,
        BOOKING_FAILED_NO_TRIP_MESSAGE,
      );
    }

    return new Response(JSON.stringify({
      error: BOOKING_FAILED_NO_TRIP_MESSAGE,
      code: "BOOKING_FAILED",
      charge_state: "no_charge",
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
