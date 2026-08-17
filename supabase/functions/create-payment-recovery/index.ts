// create-payment-recovery
//
// Controlled payment recovery for a completed trip whose original booking
// payment session is orphaned (e.g. PAYMENT_GATE_BREACH_NO_CAPTURE, or a
// PENDING provider order that cannot be recaptured).
//
// Contract:
//   POST { trip_id, amount_pence?, parent_session_id? }
//   Response: { payment_session_id, provider_order_id, checkout_url, amount, currency }
//
// Guarantees:
//   - Preserves the original session verbatim (never mutates its state or order id).
//   - Creates a NEW Revolut Merchant order with capture_mode=automatic and a
//     recovery-scoped merchant_order_ext_ref (`recover:<trip_id>:<sessionUuid>`)
//     so the webhook can find and route it deterministically.
//   - Idempotent via a partial unique index: at most ONE open recovery attempt
//     (RECOVERY_CHECKOUT_CREATED / CUSTOMER_ACTION_REQUIRED) per trip. If an
//     open attempt already exists we return its checkout URL instead of
//     creating another Revolut order.
//   - Does NOT create a trip, dispatch, or ledger entry. Reconciliation runs
//     on the webhook side once Revolut confirms COMPLETED.

import {
  corsHeaders,
  errorResponse,
  successResponse,
  logAuditEvent,
} from "../_shared/security.ts";
import {
  createRevolutOrder,
  getRevolutMerchantConfig,
  payRevolutOrderWithSavedPaymentMethod,
  resolveRevolutCheckoutUrl,
  retrieveRevolutOrder,
} from "../_shared/revolutOrders.ts";
import { resolveCurrencyFromTrip } from "../_shared/regionCurrency.ts";
import {
  computeOutstandingBalancePence,
  resolveCanonicalCustomerPayablePence,
  validateCollectOutstandingOrPaymentLinkAction,
} from "../_shared/paymentSessionsCaptureConfirmationSSOT.ts";
import {
  buildReusedRecoveryContract,
  isDriverCollectedFinancialModel,
  sumVerifiedCapturedFromSessions,
  sumVerifiedRefundedFromSessions,
} from "../_shared/tripHistoryShortfallRecaptureSSOT.ts";
import { requireAdminOrStaff } from "../_shared/adminPaymentGate.ts";
import { readTripFinancialModelStamp } from "../_shared/commissionWalletSSOT.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") {
    return errorResponse("method_not_allowed", 405, undefined, "METHOD_NOT_ALLOWED");
  }

  try {
    const gate = await requireAdminOrStaff(req);
    if (!gate.ok) return gate.response;
    const supabase = gate.supabase;
    const user = { id: gate.userId };

    const body = await req.json().catch(() => ({}));
    const { trip_id, amount_pence, parent_session_id, action_mode } = body ?? {};
    if (!trip_id) return errorResponse("trip_id is required", 400, undefined, "VALIDATION_MISSING_FIELD");

    // --- Load trip ---
    const { data: trip, error: tripErr } = await supabase
      .from("trips")
      .select("id, trip_number, status, passenger_id, service_area_id, driver_id, final_customer_fare_pence, final_fare_pence, no_show_charge_pence, cancellation_fee_pence, outstanding_balance_pence, estimated_total_pence, capture_amount_pence, currency_code, payment_status, financial_model")
      .eq("id", trip_id)
      .maybeSingle();
    if (tripErr || !trip) return errorResponse("Trip not found", 404, undefined, "TRIP_NOT_FOUND");
    if (trip.status !== "completed") {
      return errorResponse(
        `Recovery is only allowed for completed trips (status=${trip.status})`,
        409, undefined, "TRIP_NOT_COMPLETED",
      );
    }

    const financialModel = readTripFinancialModelStamp(
      trip.financial_model as string | null,
    );
    if (!financialModel) {
      return errorResponse(
        "Trip financial_model is missing",
        409,
        undefined,
        "FINANCIAL_MODEL_VIOLATION",
      );
    }
    if (isDriverCollectedFinancialModel(financialModel)) {
      return errorResponse(
        "DRIVER_COLLECTED trips cannot use platform shortfall recovery",
        409,
        undefined,
        "DRIVER_COLLECTED_NOT_ALLOWED",
      );
    }

    // --- Provider refresh on parent order (when linked) before charging ---
    if (parent_session_id) {
      const { data: parentSess } = await supabase
        .from("payment_sessions")
        .select("id, provider_order_id, captured_amount_pence, provider_state, metadata")
        .eq("id", parent_session_id)
        .maybeSingle();
      if (parentSess?.provider_order_id) {
        try {
          const { secretKey, environment } = getRevolutMerchantConfig();
          
          const order = await retrieveRevolutOrder(environment, secretKey, parentSess.provider_order_id);
          const orderState = String(order.state ?? "").toUpperCase();
          const orderAmt = typeof order.amount === "number" ? Math.round(order.amount) : null;
          const nowIso = new Date().toISOString();
          const parentPatch: Record<string, unknown> = {
            provider_state: orderState || parentSess.provider_state,
            provider_state_verified_at: nowIso,
            provider_state_verified_by: "create_payment_recovery_refresh",
            updated_at: nowIso,
          };
          if (
            (orderState === "COMPLETED" || orderState === "CAPTURED")
            && orderAmt != null
            && orderAmt > 0
            && (parentSess.captured_amount_pence == null || Number(parentSess.captured_amount_pence) <= 0)
          ) {
            parentPatch.captured_amount_pence = orderAmt;
            parentPatch.captured_at = nowIso;
            parentPatch.status = "captured";
          }
          await supabase.from("payment_sessions").update(parentPatch).eq("id", parentSess.id);
        } catch (refreshErr) {
          console.warn("[create-payment-recovery] parent provider refresh failed", refreshErr);
        }
      }
    }

    // --- Canonical payable + confirmed captures (never re-charge full fare) ---
    const payableResolved = resolveCanonicalCustomerPayablePence({
      finalCustomerFarePence: trip.final_customer_fare_pence,
      finalFarePence: trip.final_fare_pence,
      noShowChargePence: trip.no_show_charge_pence,
      cancellationFeePence: trip.cancellation_fee_pence,
      outstandingBalancePence: trip.outstanding_balance_pence,
      estimatedTotalPence: trip.estimated_total_pence,
    });

    // Re-read sessions after refresh so outstanding uses latest provider backfill.
    const { data: captureSessions } = await supabase
      .from("payment_sessions")
      .select("id, purpose, captured_amount_pence, status, provider_state, refunded_amount_pence")
      .eq("trip_id", trip.id);

    const verified = sumVerifiedCapturedFromSessions(captureSessions ?? []);
    const netRefunded = sumVerifiedRefundedFromSessions(captureSessions ?? []);
    let originalCaptured = verified.original_captured_pence;
    const recoveryCaptured = verified.recaptured_pence;
    // Trip projection may hold confirmed capture when session rows are legacy-incomplete.
    if (originalCaptured <= 0 && Number(trip.capture_amount_pence ?? 0) > 0) {
      const ps = String(trip.payment_status ?? "").toLowerCase();
      if (!ps.includes("cancel") && !ps.includes("fail") && !ps.includes("void")) {
        originalCaptured = Math.round(Number(trip.capture_amount_pence));
      }
    }

    const outstanding = computeOutstandingBalancePence({
      canonicalPayablePence: payableResolved.payable_pence,
      confirmedCapturePence: originalCaptured,
      confirmedRecoveryCapturePence: recoveryCaptured,
      netRefundedTotalPence: netRefunded,
    });

    // Provider refresh above may prove the parent order settled in full.
    // Re-sync the trip projection so Trip History stops showing a phantom shortfall.
    if (
      outstanding != null && outstanding <= 0
      && payableResolved.source !== "zero_charge"
      && (originalCaptured + recoveryCaptured) > 0
    ) {
      const capturedTotal = originalCaptured + recoveryCaptured;
      const { error: syncErr } = await supabase
        .from("trips")
        .update({
          capture_amount_pence: capturedTotal,
          outstanding_balance_pence: 0,
          payment_status: "captured",
          payment_coverage_status: "captured",
          updated_at: new Date().toISOString(),
        })
        .eq("id", trip.id);
      if (syncErr) console.error("[create-payment-recovery] trip capture sync failed", syncErr);
      return errorResponse(
        "Payment is already fully captured with the provider. The trip has been re-synced — no further charge is due.",
        409,
        undefined,
        "ALREADY_FULLY_CAPTURED",
      );
    }


    const safety = validateCollectOutstandingOrPaymentLinkAction({
      outstandingPence: outstanding,
      // Never trust client amount — always charge exact server outstanding.
      requestedAmountPence: outstanding,
      alreadyFullyCaptured: outstanding != null && outstanding <= 0,
      zeroChargeCancellation: payableResolved.source === "zero_charge",
      idempotencyKey: parent_session_id
        ? `recover:${trip.id}:${parent_session_id}:${outstanding ?? 0}`
        : `recover:${trip.id}:${outstanding ?? 0}`,
    });
    if (!safety.ok) {
      return errorResponse(safety.message, 409, undefined, safety.error_code);
    }
    if (amount_pence != null && Number(amount_pence) !== safety.charge_pence) {
      console.warn(
        "[create-payment-recovery] ignoring client amount_pence; using server outstanding",
        { client: amount_pence, server: safety.charge_pence, trip_id },
      );
    }
    // Trip History shortfall path must never accept a client charge amount.
    if (
      String(body?.source ?? "") === "trip_history_shortfall_recapture"
      && (amount_pence != null || body?.amount != null || body?.charge_pence != null)
    ) {
      return errorResponse(
        "Arbitrary charge amounts are not accepted for Trip History shortfall recapture",
        400,
        undefined,
        "AMOUNT_NOT_ALLOWED",
      );
    }
    const chargePence = safety.charge_pence;
    if (chargePence < 50) {
      return errorResponse(
        "Recovery amount must be >= 50 minor units (provider minimum).",
        400, undefined, "VALIDATION_FAILED",
      );
    }
    if (chargePence < 50) {
      return errorResponse(
        "Recovery amount must be >= 50 minor units (provider minimum).",
        400, undefined, "VALIDATION_FAILED",
      );
    }

    // --- Currency from region SSOT ---
    let currency: string;
    try {
      const r = await resolveCurrencyFromTrip(supabase, trip.id);
      currency = r.currency_code.toLowerCase();
    } catch (e) {
      return errorResponse((e as Error).message, 400, undefined, "REGION_CURRENCY_UNRESOLVABLE");
    }

    // payment_sessions SSOT requires the customer auth identity plus stable
    // action/idempotency keys. For recovery the actor is still the rider being
    // charged, not the admin pressing the button.
    const { data: customer, error: customerErr } = await supabase
      .from("customers")
      .select("id, user_id")
      .eq("id", trip.passenger_id)
      .maybeSingle();
    if (customerErr || !customer?.user_id) {
      return errorResponse(
        "Could not resolve customer identity for payment recovery",
        409, undefined, "CUSTOMER_IDENTITY_UNRESOLVABLE",
      );
    }

    const recoveryKeyScope = parent_session_id
      ? `recover:${trip.id}:${parent_session_id}`
      : `recover:${trip.id}`;

    // --- Short-circuit: if an open recovery already exists, return its URL ---
    const { data: existingOpen } = await supabase
      .from("payment_sessions")
      .select("id, provider_order_id, provider_checkout_url, status, captured_amount_pence, authorised_amount_pence, metadata")
      .eq("trip_id", trip.id)
      .eq("purpose", "PAYMENT_RECOVERY")
      .in("status", ["RECOVERY_CHECKOUT_CREATED", "CUSTOMER_ACTION_REQUIRED"])
      .maybeSingle();
    if (existingOpen) {
      // Heal older attempts that were stored without a checkout URL.
      let reusedUrl = existingOpen.provider_checkout_url as string | null;
      if (!reusedUrl && existingOpen.provider_order_id) {
        try {
          const { secretKey, environment } = getRevolutMerchantConfig();
          const existingOrder = await retrieveRevolutOrder(
            environment,
            secretKey,
            existingOpen.provider_order_id,
          );
          reusedUrl = resolveRevolutCheckoutUrl(existingOrder, environment as "live" | "sandbox");
          if (reusedUrl) {
            await supabase
              .from("payment_sessions")
              .update({ provider_checkout_url: reusedUrl, updated_at: new Date().toISOString() })
              .eq("id", existingOpen.id);
          }
        } catch (healErr) {
          console.warn("[create-payment-recovery] checkout url heal failed", healErr);
        }
      }
      const reusedContract = buildReusedRecoveryContract({
        metadata: existingOpen.metadata,
        checkout_url: reusedUrl,
        status: existingOpen.status,
      });
      return successResponse({
        payment_session_id: existingOpen.id,
        provider_order_id: existingOpen.provider_order_id,
        checkout_url: reusedUrl,
        requires_customer_action: reusedContract.requires_customer_action,
        saved_card_charged: reusedContract.saved_card_charged,
        saved_card_attempted: reusedContract.saved_card_attempted,
        saved_card_error: reusedContract.saved_card_error,
        saved_card_state: reusedContract.saved_card_state,
        amount: chargePence,
        currency,
        reused: true,
        status: existingOpen.status,
        message: reusedContract.saved_card_charged
          ? "Saved card charged off-session — awaiting provider webhook confirmation."
          : undefined,
      });
    }


    // --- Idempotent terminal success: only when shortfall is already closed.
    // A prior completed recovery that was later refunded must allow a new attempt. ---
    const { data: existingCompleted } = await supabase
      .from("payment_sessions")
      .select("id, status, provider_order_id, captured_amount_pence, currency, captured_at")
      .eq("trip_id", trip.id)
      .eq("purpose", "PAYMENT_RECOVERY")
      .in("status", ["RECOVERY_COMPLETED", "captured"])
      .maybeSingle();
    if (existingCompleted && outstanding != null && outstanding <= 0) {
      return successResponse({
        payment_session_id: existingCompleted.id,
        provider_order_id: existingCompleted.provider_order_id,
        checkout_url: null,
        amount: existingCompleted.captured_amount_pence ?? chargePence,
        currency: (existingCompleted.currency ?? currency).toString().toLowerCase(),
        status: existingCompleted.status,
        captured_at: existingCompleted.captured_at ?? null,
        already_completed: true,
        error_code: "RECOVERY_ALREADY_COMPLETED",
        message: `This trip already has a completed recovery payment (${existingCompleted.status}). Duplicate recovery blocked.`,
      });
    }

    // --- Compute a unique per-attempt scope so prior CANCELLED/FAILED/EXPIRED
    // recovery attempts do not collide on the payment_sessions unique index.
    const { count: priorAttempts } = await supabase
      .from("payment_sessions")
      .select("id", { count: "exact", head: true })
      .eq("trip_id", trip.id)
      .eq("purpose", "PAYMENT_RECOVERY");
    const firstAttemptNumber = (priorAttempts ?? 0) + 1;
    let session: { id: string } | null = null;
    let sessInsertErr: { code?: string; message?: string } | null = null;

    // --- Insert placeholder session first (reserves the "open recovery" slot) ---
    for (let offset = 0; offset < 5; offset += 1) {
      const attemptNumber = firstAttemptNumber + offset;
      const attemptScope = `${recoveryKeyScope}:attempt-${attemptNumber}:${crypto.randomUUID()}`;
      const { data, error } = await supabase
        .from("payment_sessions")
        .insert({
          client_action_id: attemptScope,
          idempotency_key: attemptScope,
          user_id: customer.user_id,
          trip_id: trip.id,
          customer_id: trip.passenger_id,
          service_area_id: trip.service_area_id,
          payment_provider: "revolut",
          purpose: "PAYMENT_RECOVERY",
          status: "RECOVERY_CHECKOUT_CREATED",
          estimated_total_pence: chargePence,
          currency: currency.toUpperCase(),
          parent_session_id: parent_session_id ?? null,
          recovery_reason: "OUTSTANDING_BALANCE",
          metadata: {
            recovery_reason: "OUTSTANDING_BALANCE",
            recovery_idempotency_key: attemptScope,
            recovery_attempt_number: attemptNumber,
            requested_by_admin_user_id: user.id,
            final_customer_charge_pence: chargePence,
            outstanding_pence: outstanding,
            canonical_payable_pence: payableResolved.payable_pence,
            payable_source: payableResolved.source,
            original_captured_pence: originalCaptured,
            recovery_captured_pence: recoveryCaptured,
            action_mode: action_mode === "payment_link" ? "payment_link" : "collect_outstanding",
            payment_link_state: action_mode === "payment_link" ? "CREATED" : null,
            parent_provider_order_preserved: true,
          },
        })
        .select("id")
        .single();

      if (data) {
        session = data;
        sessInsertErr = null;
        break;
      }

      sessInsertErr = error;
      const msg = error?.message ?? "";
      const isClientActionCollision = error?.code === "23505"
        && msg.includes("payment_sessions_client_action_id_unique");
      const isOpenRecoveryCollision = error?.code === "23505"
        && msg.includes("payment_sessions_recovery_open_unique");
      if (isOpenRecoveryCollision) {
        // Concurrent admin — return the existing open attempt instead of failing.
        const { data: racedOpen } = await supabase
          .from("payment_sessions")
          .select("id, provider_order_id, provider_checkout_url, status, captured_amount_pence, authorised_amount_pence, metadata")
          .eq("trip_id", trip.id)
          .eq("purpose", "PAYMENT_RECOVERY")
          .in("status", ["RECOVERY_CHECKOUT_CREATED", "CUSTOMER_ACTION_REQUIRED"])
          .maybeSingle();
        if (racedOpen) {
          const racedContract = buildReusedRecoveryContract({
            metadata: racedOpen.metadata,
            checkout_url: racedOpen.provider_checkout_url,
            status: racedOpen.status,
          });
          return successResponse({
            payment_session_id: racedOpen.id,
            provider_order_id: racedOpen.provider_order_id,
            checkout_url: racedOpen.provider_checkout_url,
            requires_customer_action: racedContract.requires_customer_action,
            saved_card_charged: racedContract.saved_card_charged,
            saved_card_attempted: racedContract.saved_card_attempted,
            saved_card_error: racedContract.saved_card_error,
            saved_card_state: racedContract.saved_card_state,
            amount: chargePence,
            currency,
            reused: true,
            status: racedOpen.status,
          });
        }
      }
      if (!isClientActionCollision) break;
    }

    if (!session) {
      return errorResponse(
        `Could not open a recovery session: ${sessInsertErr?.message ?? "insert failed"}`,
        409, undefined, "RECOVERY_LOCK_FAILED",
      );
    }

    // --- Create Revolut order (automatic capture — no separate capture step) ---
    let order;
    let revolutEnv: "live" | "sandbox" = "live";
    let revolutSecret = "";
    try {
      const { secretKey, environment } = getRevolutMerchantConfig();
      revolutEnv = environment as "live" | "sandbox";
      revolutSecret = secretKey;
      order = await createRevolutOrder({
        environment,
        secretKey,
        amountMinor: chargePence,
        currency,
        tripId: trip.id,
        captureMode: "automatic",
        merchantOrderExtRef: `recover:${trip.id}:${session.id}`,
        description: `ONECAB payment recovery — trip ${trip.trip_number ?? trip.id}`,
        metadata: {
          trip_id: trip.id,
          trip_number: trip.trip_number ?? "",
          purpose: "PAYMENT_RECOVERY",
          recovery_session_id: session.id,
          parent_session_id: parent_session_id ?? "",
        },
      });
    } catch (e) {
      // Roll back the reserved session so admins can retry cleanly.
      await supabase.from("payment_sessions")
        .update({ status: "RECOVERY_CANCELLED", updated_at: new Date().toISOString() })
        .eq("id", session.id);
      return errorResponse(
        `Revolut order creation failed: ${(e as Error).message}`,
        502, undefined, "PROVIDER_ORDER_CREATE_FAILED",
      );
    }

    // Checkout URL must never be missing: derive from the order token when the
    // provider omits checkout_url, and re-read the order once as a last resort.
    let checkoutUrl = resolveRevolutCheckoutUrl(order, revolutEnv);
    if (!checkoutUrl) {
      try {
        const refetched = await retrieveRevolutOrder(revolutEnv, revolutSecret, order.id);
        checkoutUrl = resolveRevolutCheckoutUrl(refetched, revolutEnv);
      } catch (urlErr) {
        console.warn("[create-payment-recovery] checkout url refetch failed", urlErr);
      }
    }

    // --- Saved-card (merchant-initiated) attempt before falling back to link ---
    let savedCardAttempt: {
      attempted: boolean;
      succeeded: boolean;
      payment_method_id: string | null;
      state: string | null;
      error: string | null;
    } = { attempted: false, succeeded: false, payment_method_id: null, state: null, error: null };

    if (action_mode !== "payment_link") {
      const { data: savedCard } = await supabase
        .from("customer_saved_payment_method_tokens")
        .select("id, provider_payment_method_id, revolut_verified, tokenization_status, payment_provider")
        .eq("user_id", customer.user_id)
        .eq("payment_provider", "revolut")
        .eq("revolut_verified", true)
        .not("provider_payment_method_id", "is", null)
        .order("verified_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (savedCard?.provider_payment_method_id) {
        savedCardAttempt.attempted = true;
        savedCardAttempt.payment_method_id = savedCard.provider_payment_method_id;
        try {
          const payment = await payRevolutOrderWithSavedPaymentMethod({
            environment: revolutEnv,
            secretKey: revolutSecret,
            orderId: order.id,
            savedPaymentMethodId: savedCard.provider_payment_method_id,
          });
          const state = String(payment.state ?? "").toUpperCase();
          savedCardAttempt.state = state || null;
          savedCardAttempt.succeeded = state === "COMPLETED"
            || state === "CAPTURED"
            || state === "AUTHORISED"
            || state === "PROCESSING";
          if (!savedCardAttempt.succeeded) {
            savedCardAttempt.error = String(payment.decline_reason ?? state ?? "not_completed");
          }
        } catch (payErr) {
          savedCardAttempt.error = (payErr as { message?: string })?.message
            ?? String(payErr);
          console.warn("[create-payment-recovery] saved-card charge failed", savedCardAttempt.error);
        }
      }
    }

    // Provider webhook remains authoritative for capture success.
    const sessionStatus = savedCardAttempt.succeeded
      ? "RECOVERY_CHECKOUT_CREATED"
      : "CUSTOMER_ACTION_REQUIRED";

    // --- Persist provider identifiers + checkout URL onto the session ---
    await supabase
      .from("payment_sessions")
      .update({
        provider_order_id: order.id,
        provider_checkout_url: checkoutUrl,
        status: sessionStatus,
        updated_at: new Date().toISOString(),
        metadata: {
          ...(order.metadata ?? {}),
          recovery_reason: "OUTSTANDING_BALANCE",
          final_customer_charge_pence: chargePence,
          outstanding_pence: outstanding,
          saved_card_attempt: savedCardAttempt,
          checkout_url_source: order.checkout_url ? "provider" : "derived_from_token",
        },
      })
      .eq("id", session.id);

    await logAuditEvent(supabase, "payment_recovery_created", {
      tripId: trip.id,
      details: {
        recovery_session_id: session.id,
        parent_session_id: parent_session_id ?? null,
        provider: "revolut",
        provider_order_id: order.id,
        amount_pence: chargePence,
        outstanding_pence: outstanding,
        canonical_payable_pence: payableResolved.payable_pence,
        currency,
        action_mode: action_mode === "payment_link" ? "payment_link" : "collect_outstanding",
        saved_card_attempt: savedCardAttempt,
      },
    });

    return successResponse({
      payment_session_id: session.id,
      provider_order_id: order.id,
      checkout_url: checkoutUrl,
      checkout_token: order.token ?? order.public_id ?? null,
      amount: chargePence,
      outstanding_pence: outstanding,
      currency,
      status: sessionStatus,
      requires_customer_action: !savedCardAttempt.succeeded,
      saved_card_charged: savedCardAttempt.succeeded,
      saved_card_attempted: savedCardAttempt.attempted,
      saved_card_error: savedCardAttempt.error,
      saved_card_state: savedCardAttempt.state,
      message: savedCardAttempt.succeeded
        ? "Saved card charged off-session — awaiting provider webhook confirmation."
        : (savedCardAttempt.attempted
          ? `Saved-card charge could not be completed (${savedCardAttempt.error ?? "declined"}). Send the payment link to the customer.`
          : "Payment link created — send it to the customer."),
      payment_link_state: action_mode === "payment_link" ? "CREATED" : null,
    });
  } catch (e) {
    console.error("[create-payment-recovery] error:", e);
    return errorResponse((e as Error).message ?? "unknown_error", 500);
  }
});
