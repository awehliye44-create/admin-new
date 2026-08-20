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
} from "./paymentSessionCaptureGateSSOT.ts";
import {
  claimPaymentSessionFinancialLock,
  releasePaymentSessionFinancialLock,
  type FinancialLockClaim,
} from "./paymentSessionFinancialLockSSOT.ts";
import { decideCaptureAfterRetrieve } from "./revolutCaptureIdempotencySSOT.ts";
import {
  captureRevolutOrder,
  retrieveRevolutOrder,
} from "./revolutOrders.ts";
import { resolveRevolutMerchantContext } from "./revolutMerchantContext.ts";
import {
  persistConfirmedProviderCapture,
  type PersistConfirmedCaptureResult,
} from "./persistConfirmedProviderCapture.ts";
import { applyCanonicalSettlementAfterCapture } from "./applyCanonicalSettlementAfterCapture.ts";
import {
  attachCapturedPostCaptureFields,
  postingWalletMismatch,
  type PostCaptureSettlementResult,
} from "./postCaptureSettlementResult.ts";
import { extractProviderCaptureId } from "../../../shared/paymentHoldProviderTerminalPure.ts";
import { recordPaymentSessionPersistFailureMetadata } from "./walletPostingMismatchSSOT.ts";
import { tripProviderOrderId } from "./tripPaymentProviderSSOT.ts";
import type { RevolutOrder } from "./revolutOrders.ts";
import { validateAdminCaptureTripPreconditions } from "./adminCaptureTripPaymentPreconditions.ts";

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
  const captureAmountTarget = pre.captureAmountPence;

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
      Number(orderBefore.amount ?? args.trip.authorised_amount_pence ?? 0),
    );
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
      const captured = await captureOrder(
        merchant.environment,
        merchant.secretKey,
        orderId,
        decision.captureAmountPence,
      );
      captureAmountPence = decision.captureAmountPence;
      revolutState = String(captured.state ?? "").toUpperCase();
      providerPayload = captured as unknown as Record<string, unknown>;
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
    posting = await applySettlement({
      supabase: args.supabase,
      tripId,
      trip: args.trip,
      captureAmountPence,
      mode: settlementMode,
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
