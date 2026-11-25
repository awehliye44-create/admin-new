/**
 * Admin capture — canonical Payment Session ownership (Step 8.2A / 8.2A.1).
 * Never writes Driver Wallet directly; delegates to applyCanonicalSettlementAfterCapture.
 *
 * Persistence ordering:
 * - Fresh capture: provider capture → persistConfirmedProviderCapture → trip mirror inside helper
 * - Already captured: persistConfirmedProviderCapture reconcile only (idempotent)
 * - Settlement: applyCanonicalSettlementAfterCapture after PS persistence
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  classifyRideBookingPaymentSessions,
  loadRideBookingPaymentSessions,
  PAYMENT_SESSION_GATE_STATUS,
} from "../../_shared/paymentSessionCaptureGateSSOT.ts";
import {
  claimPaymentSessionFinancialLock,
  releasePaymentSessionFinancialLock,
  type FinancialLockClaim,
} from "../../_shared/paymentSessionFinancialLockSSOT.ts";
import { decideCaptureAfterRetrieve, tripHasConflictingFinalCapture } from "../../_shared/revolutCaptureIdempotencySSOT.ts";
import { resolveProviderConfirmedCapturePence } from "../../_shared/providerConfirmedCaptureEvidenceSSOT.ts";
import {
  captureRevolutOrder,
  retrieveRevolutOrder,
  revolutProviderAuthorisedTotalPence,
} from "../../_shared/revolutOrders.ts";
import { guardedCaptureRevolutOrder } from "../../_shared/guardedProviderCaptureSSOT.ts";
import { assertFareCaptureAllowedAtProvider } from "../../_shared/scheduledFareCaptureGateSSOT.ts";
import { resolveRevolutMerchantContext } from "../../_shared/revolutMerchantContext.ts";
import {
  persistConfirmedProviderCapture,
  type PersistConfirmedCaptureResult,
} from "../../_shared/persistConfirmedProviderCapture.ts";
import { applyCanonicalSettlementAfterCapture } from "../../_shared/applyCanonicalSettlementAfterCapture.ts";
import {
  attachCapturedPostCaptureFields,
  postingWalletMismatch,
  type PostCaptureSettlementResult,
} from "../../_shared/postCaptureSettlementResult.ts";
import { extractProviderCaptureId } from "../../_shared/paymentHoldProviderTerminalPure.ts";
import { recordPaymentSessionPersistFailureMetadata } from "../../_shared/walletPostingMismatchSSOT.ts";
import { tripProviderOrderId } from "../../_shared/tripPaymentProviderSSOT.ts";
import type { RevolutOrder } from "../../_shared/revolutOrders.ts";
import { validateAdminCaptureTripPreconditions } from "./adminCaptureTripPaymentPreconditions.ts";
import {
  assertPlatformCollectedCompletionPaymentGate,
  CUSTOMER_PAYMENT_INCREMENT_UNRESOLVED,
} from "../../_shared/executeFareIncreaseModificationPayment.ts";
import { resolveTripFare } from "../../_shared/tripFareSSOT.ts";
import { planCaptureComposition } from "../../_shared/captureCompositionSSOT.ts";
import { acquireLockAndResolveCaptureComposition } from "../../_shared/captureCompositionAcquireSSOT.ts";
void planCaptureComposition;

export type AdminCaptureTripPaymentDeps = {
  retrieveOrder?: (
    environment: string,
    secretKey: string,
    orderId: string,
  ) => Promise<RevolutOrder>;
  captureOrder?: (
    environment: string,
    secretKey: string,
    orderId: string,
    amountPence: number,
  ) => Promise<RevolutOrder>;
  resolveMerchant?: typeof resolveRevolutMerchantContext;
  applySettlement?: typeof applyCanonicalSettlementAfterCapture;
  persistConfirmedCapture?: typeof persistConfirmedProviderCapture;
  claimLock?: typeof claimPaymentSessionFinancialLock;
  releaseLock?: typeof releasePaymentSessionFinancialLock;
};

export type AdminCaptureTripPaymentResult = {
  success: boolean;
  error_code?: string;
  error?: string;
  provider_capture_status?: "CAPTURED";
  settlement_status?: "SUCCEEDED" | "FAILED";
  wallet_posting_status?: "SUCCEEDED" | "FAILED";
  reconciliation_status?: "BALANCED" | "WALLET_MISMATCH";
  retry_provider_capture: false;
  capture_amount_pence?: number;
  provider_order_id?: string;
  payment_session_id?: string | null;
  degraded?: boolean;
  message?: string;
  revolut_state?: string | null;
};

function fail(args: Omit<AdminCaptureTripPaymentResult, "retry_provider_capture">): AdminCaptureTripPaymentResult {
  return { ...args, retry_provider_capture: false };
}

function capturedResult(
  base: Omit<AdminCaptureTripPaymentResult, "retry_provider_capture">,
  posting: PostCaptureSettlementResult,
): AdminCaptureTripPaymentResult {
  const attached = attachCapturedPostCaptureFields({ ...base, success: true }, posting);
  return { ...attached, degraded: posting.reconciliation_status === "WALLET_MISMATCH" };
}

export async function executeAdminCaptureTripPayment(args: {
  supabase: SupabaseClient;
  trip: Record<string, unknown>;
  amountPence?: number;
  deps?: AdminCaptureTripPaymentDeps;
}): Promise<AdminCaptureTripPaymentResult> {
  const pre = validateAdminCaptureTripPreconditions({
    trip: args.trip,
    amountPence: args.amountPence,
  });
  if (!pre.ok) {
    return fail({
      success: false,
      error_code: pre.error_code,
      error: pre.error,
    });
  }

  const tripId = String(args.trip.id);

  // Same completion payment gate as stop-workflow / Revolut capture (MK-260916-030).
  const paymentGate = await assertPlatformCollectedCompletionPaymentGate(
    args.supabase,
    tripId,
  );
  if (!paymentGate.ok) {
    return fail({
      success: false,
      error_code: paymentGate.code === CUSTOMER_PAYMENT_INCREMENT_UNRESOLVED
        ? CUSTOMER_PAYMENT_INCREMENT_UNRESOLVED
        : paymentGate.code,
      error: paymentGate.message,
    });
  }

  let captureAmountTarget = pre.captureAmountPence;

  const sessionLoad = await loadRideBookingPaymentSessions(args.supabase, tripId);
  if (sessionLoad.error) {
    return fail({
      success: false,
      error_code: PAYMENT_SESSION_GATE_STATUS.PAYMENT_SESSION_GATE_QUERY,
      error: sessionLoad.error.message,
    });
  }

  const classified = classifyRideBookingPaymentSessions(sessionLoad.sessions);
  if (classified.gate_status === PAYMENT_SESSION_GATE_STATUS.PAYMENT_SESSION_MISSING) {
    return fail({
      success: false,
      error_code: PAYMENT_SESSION_GATE_STATUS.PAYMENT_SESSION_MISSING,
      error: "No RIDE_BOOKING payment session for trip",
    });
  }
  if (classified.gate_status === PAYMENT_SESSION_GATE_STATUS.CAPTURE_AMBIGUOUS) {
    return fail({
      success: false,
      error_code: PAYMENT_SESSION_GATE_STATUS.CAPTURE_AMBIGUOUS,
      error: "Multiple RIDE_BOOKING payment sessions for trip",
    });
  }

  const bookingSession = classified.session!;
  const paymentSessionId = String(bookingSession.id ?? "").trim();
  if (!paymentSessionId) {
    return fail({
      success: false,
      error_code: PAYMENT_SESSION_GATE_STATUS.PAYMENT_SESSION_MISSING,
      error: "RIDE_BOOKING payment session has no id",
    });
  }

  const meta = bookingSession.metadata && typeof bookingSession.metadata === "object"
    ? bookingSession.metadata as Record<string, unknown>
    : {};
  if (meta.never_capture === true) {
    return fail({
      success: false,
      error_code: "CAPTURE_BLOCKED_NEVER_CAPTURE",
      error: "Capture blocked — payment session is flagged never_capture",
      payment_session_id: paymentSessionId,
    });
  }

  const orderId = String(bookingSession.provider_order_id ?? tripProviderOrderId(args.trip) ?? "").trim();
  if (!orderId) {
    return fail({
      success: false,
      error_code: "PROVIDER_ORDER_MISSING",
      error: "Trip has no Revolut order",
    });
  }

  const clientActionId = String(args.trip.client_action_id ?? "").trim() || null;
  const captureOwner = `admin-capture:${tripId}`;

  const claimLock = args.deps?.claimLock ?? claimPaymentSessionFinancialLock;
  const releaseLock = args.deps?.releaseLock ?? releasePaymentSessionFinancialLock;
  const lock: FinancialLockClaim = await claimLock(args.supabase, {
    paymentSessionId,
    owner: captureOwner,
    state: "CAPTURING",
    operationKey: `admin-capture:${orderId}`,
  });
  if (!lock.ok) {
    return fail({
      success: false,
      error_code: "CAPTURE_BUSY",
      error: `Financial operation busy (${lock.currentState ?? "unknown"}); capture not started`,
      payment_session_id: paymentSessionId,
      provider_order_id: orderId,
    });
  }

  const resolveMerchant = args.deps?.resolveMerchant ?? resolveRevolutMerchantContext;
  const retrieveOrder = args.deps?.retrieveOrder ?? retrieveRevolutOrder;
  const captureOrder = args.deps?.captureOrder ?? captureRevolutOrder;
  const persistConfirmedCapture = args.deps?.persistConfirmedCapture ?? persistConfirmedProviderCapture;
  const applySettlement = args.deps?.applySettlement ?? applyCanonicalSettlementAfterCapture;

  let providerCaptureConfirmed = false;
  let captureAmountPence = captureAmountTarget;
  let settlementMode: "fresh_capture" | "recovery" = "fresh_capture";
  let revolutState: string | null = null;
  let lockReleaseState: "CAPTURED" | "IDLE" = "IDLE";
  let earlyFail: AdminCaptureTripPaymentResult | null = null;

  try {
    const merchant = await resolveMerchant(args.supabase, "live");
    const orderBefore = await retrieveOrder(merchant.environment, merchant.secretKey, orderId);
    revolutState = String(orderBefore.state ?? "").toUpperCase();

    const authorisedTotal = Math.max(
      0,
      revolutProviderAuthorisedTotalPence(orderBefore)
        || Number(orderBefore.amount ?? args.trip.authorised_amount_pence ?? 0),
    );

    // Capture composition under the financial lock already claimed above.
    const tipForPlan = Math.max(
      0,
      Math.round(Number(args.trip.tip_pence ?? args.trip.tip_amount_pence ?? 0) || 0),
    );
    const resolvedFare = resolveTripFare(args.trip as never, tipForPlan);
    const resolved = await acquireLockAndResolveCaptureComposition(args.supabase, {
      payment_session_id: paymentSessionId,
      provider_order_id: orderId,
      trip_fare_component_pence: Math.max(0, resolvedFare.final_fare_pence),
      tip_component_pence: tipForPlan,
      preauth_buffer_component_pence: Math.max(
        0,
        Math.round(Number(args.trip.preauth_buffer_pence ?? bookingSession.buffer_pence ?? 0) || 0),
      ),
      authorised_total_pence: Math.max(
        authorisedTotal,
        Math.round(Number(bookingSession.total_authorised_amount_pence) || 0),
        Math.round(Number(bookingSession.authorised_amount_pence) || 0),
      ),
      lock_owner: captureOwner,
      lock_already_held: true,
      operation_key: `admin-capture:${orderId}`,
    });
    if (!resolved.ok) {
      earlyFail = fail({
        success: false,
        error_code: resolved.code,
        error: resolved.error,
        payment_session_id: paymentSessionId,
        provider_order_id: orderId,
      });
      return earlyFail;
    }
    if (
      args.amountPence != null
      && Math.round(Number(args.amountPence)) !== resolved.provider_capture_target_pence
    ) {
      earlyFail = fail({
        success: false,
        error_code: "CAPTURE_COMPOSITION_MISMATCH",
        error:
          `amount_pence (${Math.round(Number(args.amountPence))}) does not match ` +
          `capture composition target (${resolved.provider_capture_target_pence})`,
        payment_session_id: paymentSessionId,
        provider_order_id: orderId,
      });
      return earlyFail;
    }
    captureAmountTarget = resolved.provider_capture_target_pence;

    if (captureAmountTarget > authorisedTotal && revolutState === "AUTHORISED") {
      earlyFail = fail({
        success: false,
        error_code: "CAPTURE_ABOVE_AUTHORISED",
        error: `amount_pence (${captureAmountTarget}) exceeds authorised (${authorisedTotal})`,
        payment_session_id: paymentSessionId,
        provider_order_id: orderId,
      });
      return earlyFail;
    }

    const decision = decideCaptureAfterRetrieve({
      paymentSessionId,
      providerOrderId: orderId,
      order: orderBefore,
      finalFarePence: captureAmountTarget,
    });

    let providerPayload: Record<string, unknown>;

    if (decision.action === "reconcile_already_captured") {
      settlementMode = "recovery";
      captureAmountPence = decision.captureAmountPence;
      providerPayload = orderBefore as unknown as Record<string, unknown>;
    } else if (decision.action === "retry_capture") {
      // #89E/#90A: trips.capture_amount_pence is never confirmed capture evidence.
      const sessionStatus = String(bookingSession.status ?? "").toLowerCase();
      const confirmed = resolveProviderConfirmedCapturePence({
        providerState: String((orderBefore as { state?: string }).state ?? ""),
        providerCapturedPence: null,
        sessionStatus,
        sessionCapturedPence: bookingSession.captured_amount_pence as number | null | undefined,
        paymentCapturedPence: null,
      });
      if (tripHasConflictingFinalCapture({
        confirmedCapturePence: confirmed,
        requestedCapturePence: decision.captureAmountPence,
      })) {
        earlyFail = fail({
          success: false,
          error_code: "FINAL_CAPTURE_AMOUNT_CONFLICT",
          error: "Final capture already confirmed; different amount refused",
          payment_session_id: paymentSessionId,
          provider_order_id: orderId,
        });
        return earlyFail;
      }
      const fareGate = assertFareCaptureAllowedAtProvider({
        tripStatus: args.trip.status,
        captureKind: "fare",
      });
      if (!fareGate.ok) {
        earlyFail = fail({
          success: false,
          error_code: "TRIP_NOT_COMPLETED",
          error: fareGate.error,
          payment_session_id: paymentSessionId,
          provider_order_id: orderId,
        });
        return earlyFail;
      }
      // G2: canonical guarded capture (claim → POST → GET confirm).
      void captureOrder;
      try {
        const { writeAuthoritativePayableSnapshot } = await import(
          "../../_shared/writeAuthoritativePayableSnapshotSSOT.ts"
        );
        await writeAuthoritativePayableSnapshot(args.supabase, {
          tripId,
          trip: args.trip,
          source: "admin_capture",
          waitingBasis: "columns",
          totalPayableOverridePence: decision.captureAmountPence,
        });
      } catch (snapErr) {
        console.warn("[admin-capture] payable snapshot soft fail", snapErr);
      }
      const guarded = await guardedCaptureRevolutOrder({
        supabase: args.supabase,
        environment: merchant.environment,
        secretKey: merchant.secretKey,
        tripId,
        paymentSessionId,
        providerOrderId: orderId,
        amountPence: decision.captureAmountPence,
        purpose: "fare",
      });
      if (!guarded.ok) {
        earlyFail = fail({
          success: false,
          error_code: guarded.code,
          error: guarded.message,
          payment_session_id: paymentSessionId,
          provider_order_id: orderId,
          revolut_state: String(guarded.order?.state ?? revolutState),
        });
        return earlyFail;
      }
      revolutState = String(guarded.order.state ?? "").toUpperCase();
      captureAmountPence = guarded.confirmedCapturedPence;
      providerPayload = guarded.order as unknown as Record<string, unknown>;
    } else {
      earlyFail = fail({
        success: false,
        error_code: decision.action.toUpperCase(),
        error: `Cannot capture — Revolut order state is "${revolutState}" (${decision.action})`,
        payment_session_id: paymentSessionId,
        provider_order_id: orderId,
        revolut_state: revolutState,
      });
      return earlyFail;
    }

    const persist: PersistConfirmedCaptureResult = await persistConfirmedCapture({
      supabase: args.supabase,
      tripId,
      clientActionId,
      providerOrderId: orderId,
      providerPayload,
      providerState: revolutState,
      captureAmountPence,
      providerCaptureId: extractProviderCaptureId(providerPayload),
      verifiedBy: "admin-capture-trip-payment",
      source: "admin-capture-trip-payment",
    });

    if (!persist.applied && persist.reason !== "idempotent_already_persisted") {
      earlyFail = fail({
        success: false,
        error_code: persist.classification,
        error: `Failed to persist confirmed capture: ${persist.reason}`,
        payment_session_id: paymentSessionId,
        provider_order_id: orderId,
      });
      return earlyFail;
    }

    providerCaptureConfirmed = true;
    lockReleaseState = "CAPTURED";
  } catch (err) {
    lockReleaseState = "IDLE";
    throw err;
  } finally {
    await releaseLock(args.supabase, {
      paymentSessionId,
      owner: captureOwner,
      nextState: lockReleaseState,
    });
  }

  if (earlyFail) return earlyFail;

  if (!providerCaptureConfirmed) {
    return fail({
      success: false,
      error_code: "CAPTURE_NOT_CONFIRMED",
      error: "Provider capture was not confirmed",
      payment_session_id: paymentSessionId,
      provider_order_id: orderId,
    });
  }

  let posting: PostCaptureSettlementResult;
  try {
    const tripFareComponent = Math.max(
      0,
      Math.round(
        Number(
          (bookingSession as { trip_fare_component_pence?: number }).trip_fare_component_pence
            ?? (bookingSession as { metadata?: Record<string, unknown> }).metadata
              ?.trip_fare_component_pence,
        ) || 0,
      ),
    );
    posting = await applySettlement({
      supabase: args.supabase,
      tripId,
      trip: {
        ...args.trip,
        ...(tripFareComponent > 0
          ? { trip_fare_component_pence: tripFareComponent }
          : {}),
      },
      captureAmountPence,
      mode: settlementMode,
      tripFareComponentPence: tripFareComponent > 0 ? tripFareComponent : undefined,
    });
  } catch (settlementErr) {
    console.error("[adminCaptureTripPayment] settlement failed", settlementErr);
    await recordPaymentSessionPersistFailureMetadata(args.supabase, {
      tripId,
      tripCode: args.trip.trip_code ? String(args.trip.trip_code) : null,
      errorMessage: settlementErr instanceof Error ? settlementErr.message : String(settlementErr),
    }).catch(() => undefined);
    posting = postingWalletMismatch({
      settlement_status: "FAILED",
      expectedPence: Math.round(Number(args.trip.driver_net_pence) || 0),
      postedPence: 0,
    });
  }

  return capturedResult({
    capture_amount_pence: captureAmountPence,
    provider_order_id: orderId,
    payment_session_id: paymentSessionId,
    message: settlementMode === "recovery"
      ? "Provider already captured; reconciled without re-capture"
      : `Captured ${(captureAmountPence / 100).toFixed(2)} successfully`,
    revolut_state: revolutState,
  }, posting);
}
