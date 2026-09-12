/**
 * P0 — Revolut trip completion capture with hold reconciliation.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import { planRevolutCompletionCapture } from "../../../shared/revolutPaymentHoldSSOT.ts";
import { computeCaptureAmount, resolveTripFare } from "./tripFareSSOT.ts";
import { resolveRevolutMerchantContext } from "./revolutMerchantContext.ts";
import {
  captureRevolutOrder,
  mapRevolutStateToPaymentStatus,
  retrieveRevolutOrder,
  revolutProviderAuthorisedTotalPence,
} from "./revolutOrders.ts";
import { executeSameOrderIncrement } from "./executeSameOrderIncrementSSOT.ts";
import { safeCaptureAfterIncrementDecline } from "./paymentRecoveryGuardSSOT.ts";
import {
  claimPaymentSessionFinancialLock,
  releasePaymentSessionFinancialLock,
} from "./paymentSessionFinancialLockSSOT.ts";
import { decideCaptureAfterRetrieve, tripHasConflictingFinalCapture } from "./revolutCaptureIdempotencySSOT.ts";
import { applyCanonicalSettlementAfterCapture } from "./applyCanonicalSettlementAfterCapture.ts";
import {
  attachCapturedPostCaptureFields,
  postingWalletMismatch,
  type PostCaptureSettlementResult,
} from "./postCaptureSettlementResult.ts";
import { FINANCIAL_MODEL_VIOLATION, SERVICE_AREA_FINANCIAL_MODEL } from "./commissionWalletSSOT.ts";
import { recordPaymentSessionPersistFailureMetadata } from "./walletPostingMismatchSSOT.ts";
import {
  markPaymentSessionCaptured,
  markPaymentSessionCaptureResidualRelease,
  markPaymentSessionCompletedPendingCapture,
  markPaymentSessionPaymentShortfall,
  markPaymentSessionProviderFee,
} from "./paymentSessionSSOT.ts";
import { extractConfirmedCaptureAmountPence, extractProviderCaptureId } from "../../../shared/paymentHoldProviderTerminalPure.ts";
import { tipCollectedFromConfirmedCapture } from "../../../shared/tripPaymentFinalised.ts";
import { extractProviderFeePence } from "../../../shared/paymentCaptureEvidenceSSOT.ts";
import {
  RELEASE_EVIDENCE_SOURCE,
} from "../../../shared/paymentSessionReleaseEvidenceSSOT.ts";
import {
  assertCaptureWithinTotalAuthorised,
} from "../../../shared/paymentSessionAdditionalAuthSSOT.ts";
import type { FinalizeRevolutCaptureResult } from "./finalizeRevolutTripCapture.ts";
import {
  buildPaymentResolutionPersistPatch,
  markAdditionalAuthPendingOrRecovery,
  planFinalFareAgainstAuthorisation,
  PAYMENT_RESOLUTION_STATUS,
} from "../../../shared/finalFareAuthorisationSSOT.ts";

async function persistPostCaptureResidualReleaseEvidence(args: {
  supabase: SupabaseClient;
  clientActionId: string | null;
  providerOrderId: string;
  tripId: string;
  authorisedHoldPence: number;
  capturedAmountPence: number;
  environment: Parameters<typeof retrieveRevolutOrder>[0];
  secretKey: string;
  evidenceSource: string;
}): Promise<{
  release_evidence_status: string;
  released_amount_pence: number | null;
  expected_release_pence: number;
  messageSuffix: string;
}> {
  let retrieveSucceeded = false;
  let providerPayload: Record<string, unknown> | null = null;
  try {
    const orderAfter = await retrieveRevolutOrder(
      args.environment,
      args.secretKey,
      args.providerOrderId,
    );
    retrieveSucceeded = true;
    providerPayload = orderAfter as unknown as Record<string, unknown>;
  } catch (err) {
    console.warn("[revolutCompletionCapture] post-capture retrieve failed", err);
  }

  const result = await markPaymentSessionCaptureResidualRelease(args.supabase, {
    clientActionId: args.clientActionId,
    providerOrderId: args.providerOrderId,
    tripId: args.tripId,
    authorisedHoldPence: args.authorisedHoldPence,
    capturedAmountPence: args.capturedAmountPence,
    providerPayload,
    retrieveSucceeded,
    evidenceSource: args.evidenceSource,
    providerReleaseReference: args.providerOrderId,
  });

  // Slice 3: persist provider-confirmed fee from post-capture retrieve (never invent £0).
  try {
    await markPaymentSessionProviderFee(args.supabase, {
      clientActionId: args.clientActionId,
      providerOrderId: args.providerOrderId,
      providerFeePence: extractProviderFeePence(providerPayload),
      retrieveSucceeded,
    });
  } catch (feeErr) {
    console.warn("[revolutCompletionCapture] fee persist failed", feeErr);
  }

  const c = result.classification;
  let messageSuffix = "";
  if (c.release_evidence_status === "NOT_REQUIRED") {
    messageSuffix = "";
  } else if (c.release_evidence_status === "CONFIRMED" && c.released_amount_pence != null) {
    messageSuffix = `; residual release confirmed ${c.released_amount_pence}p`;
  } else if (c.release_evidence_status === "AMOUNT_UNCONFIRMED") {
    messageSuffix =
      `; residual authorisation no longer held (expected ${c.expected_release_pence}p, amount unconfirmed)`;
  } else if (c.release_evidence_status === "PENDING_PROVIDER_CONFIRMATION") {
    messageSuffix = `; residual release pending provider confirmation (expected ${c.expected_release_pence}p)`;
  } else if (c.release_evidence_status === "PROVIDER_STATE_UNAVAILABLE") {
    messageSuffix = `; residual release evidence unavailable (expected ${c.expected_release_pence}p)`;
  }

  return {
    release_evidence_status: c.release_evidence_status,
    released_amount_pence: c.released_amount_pence,
    expected_release_pence: c.expected_release_pence,
    messageSuffix,
  };
}

function capturedWithPosting(
  base: FinalizeRevolutCaptureResult,
  posting: PostCaptureSettlementResult,
): FinalizeRevolutCaptureResult {
  return attachCapturedPostCaptureFields(base, posting);
}

function capturedWalletNotPosted(base: FinalizeRevolutCaptureResult): FinalizeRevolutCaptureResult {
  return attachCapturedPostCaptureFields(
    base,
    postingWalletMismatch({
      settlement_status: "FAILED",
      expectedPence: 0,
      postedPence: 0,
    }),
  );
}

export async function executeRevolutTripCompletionCapture(args: {
  supabase: SupabaseClient;
  trip: Record<string, unknown>;
  tipPence?: number;
}): Promise<FinalizeRevolutCaptureResult> {
  if (
    String(args.trip.financial_model ?? "").toUpperCase()
    === SERVICE_AREA_FINANCIAL_MODEL.DRIVER_COLLECTED_COMMISSION_WALLET
  ) {
    throw new Error(
      `${FINANCIAL_MODEL_VIOLATION}: platform capture forbidden on DRIVER_COLLECTED_COMMISSION_WALLET`,
    );
  }

  const tripId = String(args.trip.id);
  const tripStatus = String(args.trip.status ?? "").toLowerCase();
  const orderId = String(args.trip.provider_order_id ?? "").trim();
  const clientActionId = String(args.trip.client_action_id ?? "").trim() || null;

  if (!orderId) {
    return {
      success: false,
      status: "failed",
      capture_amount_pence: 0,
      provider_order_id: "",
      error: "Trip has no Revolut order id",
    };
  }

  if (tripStatus !== "completed") {
    return {
      success: false,
      status: "trip_not_completed",
      capture_amount_pence: 0,
      provider_order_id: orderId,
      error: "Cannot capture Revolut hold before trip is completed",
    };
  }

  const safeTipPence = Math.max(0, Math.round(args.tipPence ?? 0));
  const tripForFare = { ...args.trip, tip_pence: safeTipPence, tip_amount_pence: safeTipPence };
  const resolvedFare = resolveTripFare(tripForFare, safeTipPence);
  const captureResolution = computeCaptureAmount(tripForFare, "completed", safeTipPence);
  const finalFarePence = Math.max(0, captureResolution.capture_amount_pence);

  const merchant = await resolveRevolutMerchantContext(args.supabase, "live");
  const orderBefore = await retrieveRevolutOrder(
    merchant.environment,
    merchant.secretKey,
    orderId,
  );
  const state = String(orderBefore.state ?? "").toUpperCase();
  let authorisedHoldPence = Math.max(
    0,
    revolutProviderAuthorisedTotalPence(orderBefore)
      || Number(orderBefore.amount ?? args.trip.authorised_amount_pence ?? 0),
  );
  const bufferPence = Math.max(0, Number(args.trip.preauth_buffer_pence ?? 0));

  const storedTripCapture = Math.round(Number(args.trip.capture_amount_pence) || 0);
  let storedSessionCapture = 0;
  const { data: capturedSession } = await args.supabase
    .from("payment_sessions")
    .select("captured_amount_pence, status")
    .eq("provider_order_id", orderId)
    .neq("purpose", "PAYMENT_RECOVERY")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const sessionStatus = String(capturedSession?.status ?? "").toLowerCase();
  const sessionCaptured =
    sessionStatus === "captured"
    || sessionStatus === "completed"
    || sessionStatus === "capture_confirmed"
    || sessionStatus === "partial_capture_only";
  if (sessionCaptured) {
    storedSessionCapture = Math.round(Number(capturedSession?.captured_amount_pence) || 0);
  }
  let storedPaymentCapture = 0;
  const { data: capturedPayment, error: capturedPaymentErr } = await args.supabase
    .from("payments")
    .select("captured_amount_pence, status")
    .eq("trip_id", tripId)
    .limit(8);
  if (capturedPaymentErr) {
    console.warn("[revolutCompletionCapture] payments capture lookup failed", capturedPaymentErr.message);
  }
  for (const row of capturedPayment ?? []) {
    const payStatus = String(row.status ?? "").toLowerCase();
    if (payStatus !== "captured" && payStatus !== "succeeded" && payStatus !== "paid") continue;
    const amt = Math.round(Number(row.captured_amount_pence) || 0);
    if (amt > storedPaymentCapture) storedPaymentCapture = amt;
  }
  const confirmedFinalCapturePence = storedTripCapture > 0
    ? storedTripCapture
    : storedSessionCapture > 0
      ? storedSessionCapture
      : storedPaymentCapture;

  const refuseDifferentFinalCapture = async (requestedPence: number) => {
    const { data: freshTrip } = await args.supabase
      .from("trips")
      .select("capture_amount_pence")
      .eq("id", tripId)
      .maybeSingle();
    const stored = Math.round(Number(freshTrip?.capture_amount_pence) || 0);
    let freshSessionCapture = 0;
    const { data: freshSession } = await args.supabase
      .from("payment_sessions")
      .select("captured_amount_pence, status")
      .eq("provider_order_id", orderId)
      .neq("purpose", "PAYMENT_RECOVERY")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const freshStatus = String(freshSession?.status ?? "").toLowerCase();
    if (
      freshStatus === "captured"
      || freshStatus === "completed"
      || freshStatus === "capture_confirmed"
      || freshStatus === "partial_capture_only"
    ) {
      freshSessionCapture = Math.round(Number(freshSession?.captured_amount_pence) || 0);
    }
    let freshPaymentCapture = 0;
    const { data: freshPayments } = await args.supabase
      .from("payments")
      .select("captured_amount_pence, status")
      .eq("trip_id", tripId)
      .limit(8);
    for (const row of freshPayments ?? []) {
      const payStatus = String(row.status ?? "").toLowerCase();
      if (payStatus !== "captured" && payStatus !== "succeeded" && payStatus !== "paid") continue;
      const amt = Math.round(Number(row.captured_amount_pence) || 0);
      if (amt > freshPaymentCapture) freshPaymentCapture = amt;
    }
    const confirmed = stored > 0
      ? stored
      : freshSessionCapture > 0
        ? freshSessionCapture
        : freshPaymentCapture > 0
          ? freshPaymentCapture
          : confirmedFinalCapturePence;
    if (!tripHasConflictingFinalCapture({
      confirmedCapturePence: confirmed,
      requestedCapturePence: requestedPence,
    })) {
      return null;
    }
    const covered = tipCollectedFromConfirmedCapture({
      captureAmountPence: confirmed,
      farePlusTipPence: requestedPence,
      requestedTipPence: safeTipPence,
    });
    console.log(JSON.stringify({
      event: "final_capture_amount_conflict",
      trip_id: tripId,
      confirmed_capture_pence: confirmed,
      requested_capture_pence: requestedPence,
    }));
    return {
      success: true as const,
      status: "already_captured",
      capture_amount_pence: confirmed,
      provider_order_id: orderId,
      tip_collected_pence: covered.tipCollectedPence,
      tip_shortfall_pence: covered.tipShortfallPence,
      message: "Final capture already confirmed; different amount refused",
    };
  };

  if (
    state !== "COMPLETED" &&
    state !== "CAPTURED" &&
    tripHasConflictingFinalCapture({
      confirmedCapturePence: confirmedFinalCapturePence,
      requestedCapturePence: finalFarePence,
    })
  ) {
    const covered = tipCollectedFromConfirmedCapture({
      captureAmountPence: confirmedFinalCapturePence,
      farePlusTipPence: finalFarePence,
      requestedTipPence: safeTipPence,
    });
    console.log(JSON.stringify({
      event: "final_capture_amount_conflict",
      trip_id: tripId,
      confirmed_capture_pence: confirmedFinalCapturePence,
      requested_capture_pence: finalFarePence,
    }));
    return {
      success: true,
      status: "already_captured",
      capture_amount_pence: confirmedFinalCapturePence,
      provider_order_id: orderId,
      tip_collected_pence: covered.tipCollectedPence,
      tip_shortfall_pence: covered.tipShortfallPence,
      message: "Final capture already confirmed; different amount refused",
    };
  }

  if (state === "COMPLETED") {
    const extractedCapture = extractConfirmedCaptureAmountPence(
      orderBefore as unknown as Record<string, unknown>,
      "COMPLETED",
    );
    const storedCapture = Math.round(Number(args.trip.capture_amount_pence) || 0);
    // Never treat the requested fare+tip as captured. A missing provider amount
    // must not close the tip window or credit a tip the card did not pay.
    const captureAmountPence = extractedCapture != null && extractedCapture > 0
      ? extractedCapture
      : (storedCapture > 0 ? storedCapture : 0);
    if (captureAmountPence <= 0) {
      return {
        success: false,
        status: "capture_amount_unresolved",
        capture_amount_pence: 0,
        provider_order_id: orderId,
        error: "Revolut order is completed but the captured amount is unresolved",
      };
    }
    const tipCoverage = tipCollectedFromConfirmedCapture({
      captureAmountPence,
      farePlusTipPence: finalFarePence,
      requestedTipPence: safeTipPence,
    });
    const now = new Date().toISOString();
    let residualMsg = "";
    let paymentSessionPersisted = false;
    try {
      await args.supabase.from("trips").update({
        payment_status: "captured",
        payment_hold_status: "captured",
        capture_amount_pence: captureAmountPence,
        provider_charge_id: orderBefore.id ?? orderId,
        updated_at: now,
      }).eq("id", tripId);
      await args.supabase.from("payments").update({
        status: "captured",
        captured_amount_pence: captureAmountPence,
        provider_status: orderBefore.state ?? "COMPLETED",
        updated_at: now,
      }).eq("provider_order_id", orderId);
      await markPaymentSessionCaptured(args.supabase, {
        clientActionId,
        providerOrderId: orderId,
        tripId,
        captureAmountPence,
        capturedAt: now,
        providerCaptureId: extractProviderCaptureId(
          orderBefore as unknown as Record<string, unknown>,
        ),
      });
      paymentSessionPersisted = true;
      const residual = await persistPostCaptureResidualReleaseEvidence({
        supabase: args.supabase,
        clientActionId,
        providerOrderId: orderId,
        tripId,
        authorisedHoldPence: authorisedHoldPence,
        capturedAmountPence,
        environment: merchant.environment,
        secretKey: merchant.secretKey,
        evidenceSource: RELEASE_EVIDENCE_SOURCE.REVOLUT_ALREADY_CAPTURED_RECONCILE,
      });
      residualMsg = residual.messageSuffix;
    } catch (persistErr) {
      console.error("[revolutCompletionCapture] already_captured persist failed", persistErr);
      if (!paymentSessionPersisted) {
        await recordPaymentSessionPersistFailureMetadata(args.supabase, {
          tripId,
          tripCode: args.trip.trip_code ? String(args.trip.trip_code) : null,
          errorMessage: persistErr instanceof Error ? persistErr.message : String(persistErr),
        });
      }
    }
    if (paymentSessionPersisted) {
      try {
        const { data: tripFresh } = await args.supabase
          .from("trips")
          .select("*")
          .eq("id", tripId)
          .maybeSingle();
        const posting = await applyCanonicalSettlementAfterCapture({
          supabase: args.supabase,
          tripId,
          mode: "recovery",
          trip: {
            ...(tripFresh ?? args.trip),
            ...resolvedFare,
            final_fare_pence: resolvedFare.final_fare_pence,
            pickup_waiting_charge_pence: resolvedFare.arrival_waiting_charge_pence,
            stop_waiting_charge_pence: resolvedFare.stop_waiting_charge_pence,
            driver_net_pence: (tripFresh ?? args.trip).driver_net_pence
              ?? args.trip.driver_net_pence,
            accepted_commission_percent: (tripFresh ?? args.trip).accepted_commission_percent
              ?? args.trip.accepted_commission_percent,
            driver_tier_commission_percent: (tripFresh ?? args.trip).driver_tier_commission_percent
              ?? args.trip.driver_tier_commission_percent,
            commission_pct: (tripFresh ?? args.trip).commission_pct
              ?? args.trip.commission_pct,
          },
          captureAmountPence,
          tipPence: tipCoverage.tipCollectedPence,
        });
        return capturedWithPosting({
          success: true,
          status: "already_captured",
          capture_amount_pence: captureAmountPence,
          provider_order_id: orderId,
          tip_collected_pence: tipCoverage.tipCollectedPence,
          tip_shortfall_pence: tipCoverage.tipShortfallPence,
          message: `Revolut order already captured${residualMsg}`,
        }, posting);
      } catch (ledgerErr) {
        console.error("[revolutCompletionCapture] already_captured settlement failed", ledgerErr);
        return capturedWalletNotPosted({
          success: true,
          status: "already_captured",
          capture_amount_pence: captureAmountPence,
          provider_order_id: orderId,
          tip_collected_pence: tipCoverage.tipCollectedPence,
          tip_shortfall_pence: tipCoverage.tipShortfallPence,
          message: `Revolut order already captured${residualMsg}`,
        });
      }
    }
    return capturedWalletNotPosted({
      success: true,
      status: "already_captured",
      capture_amount_pence: captureAmountPence,
      provider_order_id: orderId,
      tip_collected_pence: tipCoverage.tipCollectedPence,
      tip_shortfall_pence: tipCoverage.tipShortfallPence,
      message: `Revolut order already captured${residualMsg}`,
    });
  }

  await markPaymentSessionCompletedPendingCapture(args.supabase, {
    clientActionId,
    providerOrderId: orderId,
    tripId,
  });

  if (state !== "AUTHORISED" && state !== "PROCESSING") {
    return {
      success: false,
      status: state.toLowerCase() || "failed",
      capture_amount_pence: 0,
      provider_order_id: orderId,
      error: `Cannot capture Revolut order in state ${state}`,
    };
  }

  let plan = planRevolutCompletionCapture({
    finalFarePence,
    authorisedHoldPence,
    bufferPence,
    preferSameOrderIncrement: true,
  });
  const fareAuthPlan = planFinalFareAgainstAuthorisation({
    originalAuthorisedPence: authorisedHoldPence,
    finalChargePence: finalFarePence,
  });

  if (plan.kind === "same_order_increment_required") {
    console.log(JSON.stringify({
      event: "increment_completion_capture_started",
      trip_id: tripId,
      provider_order_id: `${orderId.slice(0, 4)}…${orderId.slice(-4)}`,
      previous_total: authorisedHoldPence,
      requested_target: plan.target_total_authorised_pence,
    }));

    const { data: paymentSession } = await args.supabase
      .from("payment_sessions")
      .select("id")
      .eq("provider_order_id", orderId)
      .neq("purpose", "PAYMENT_RECOVERY")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!paymentSession?.id) {
      return {
        success: false,
        status: "ADDITIONAL_AUTHORISATION_UNKNOWN",
        capture_amount_pence: 0,
        provider_order_id: orderId,
        error: "Payment session missing for same-order increment; reconcile before fallback.",
      };
    }

    const incrementResult = await executeSameOrderIncrement({
      supabase: args.supabase,
      environment: merchant.environment,
      secretKey: merchant.secretKey,
      paymentSessionId: String(paymentSession.id),
      providerOrderId: orderId,
      requiredTotalPence: plan.target_total_authorised_pence,
      currency: String(args.trip.currency_code ?? orderBefore.currency ?? "GBP"),
      source: "completion_capture",
      reason: "final_fare_exceeds_authorised_hold",
      owner: `finalize:${tripId}`,
    });

    if (incrementResult.ok) {
      authorisedHoldPence = incrementResult.providerConfirmedTotalPence;
      plan = planRevolutCompletionCapture({
        finalFarePence,
        authorisedHoldPence,
        bufferPence,
        preferSameOrderIncrement: true,
      });
    } else if (
      incrementResult.kind === "declined"
      || incrementResult.kind === "unsupported"
      || incrementResult.kind === "provider_limit"
      || incrementResult.kind === "ineligible"
    ) {
      const safe = safeCaptureAfterIncrementDecline({
        finalFarePence,
        providerConfirmedAuthorisedTotalPence: incrementResult.providerConfirmedTotalPence,
      });
      if (safe.capturePence <= 0) {
        await markPaymentSessionPaymentShortfall(args.supabase, {
          clientActionId,
          tripId,
          shortfallPence: safe.shortfallPence,
          reason: `Increment ${incrementResult.kind}: ${incrementResult.message}`,
        });
        return {
          success: false,
          status: "PAYMENT_RECOVERY_REQUIRED",
          capture_amount_pence: 0,
          provider_order_id: orderId,
          error: incrementResult.message,
        };
      }
      const safeLock = await claimPaymentSessionFinancialLock(args.supabase, {
        paymentSessionId: String(paymentSession.id),
        owner: `capture:${tripId}`,
        state: "CAPTURING",
        operationKey: `capture:${orderId}:${safe.capturePence}`,
      });
      if (!safeLock.ok) {
        const blockedBusy = await refuseDifferentFinalCapture(safe.capturePence);
        if (blockedBusy) return blockedBusy;
        return {
          success: false,
          status: "capture_busy",
          capture_amount_pence: 0,
          provider_order_id: orderId,
          error: `Financial operation busy (${safeLock.currentState ?? "unknown"}); capture not started`,
        };
      }
      let safeCapturedOk = false;
      try {
        const blockedSafe = await refuseDifferentFinalCapture(safe.capturePence);
        if (blockedSafe) return blockedSafe;
        const capturedSafe = await captureRevolutOrder(
          merchant.environment,
          merchant.secretKey,
          orderId,
          safe.capturePence,
        );
        safeCapturedOk = true;
        const nowSafe = new Date().toISOString();
        try {
          await markPaymentSessionCaptured(args.supabase, {
            clientActionId,
            providerOrderId: orderId,
            tripId,
            captureAmountPence: safe.capturePence,
            capturedAt: nowSafe,
            providerCaptureId: extractProviderCaptureId(
              capturedSafe as unknown as Record<string, unknown>,
            ),
          });
        } catch (psErr) {
          console.error("[revolutCompletionCapture] Payment Sessions persist failed after provider capture", psErr);
          await recordPaymentSessionPersistFailureMetadata(args.supabase, {
            tripId,
            tripCode: args.trip.trip_code ? String(args.trip.trip_code) : null,
            errorMessage: psErr instanceof Error ? psErr.message : String(psErr),
          });
          return capturedWalletNotPosted({
            success: true,
            status: safe.shortfallPence > 0 ? "PARTIAL_CAPTURE_ONLY" : "captured",
            capture_amount_pence: safe.capturePence,
            provider_order_id: orderId,
            tip_collected_pence: tipCollectedFromConfirmedCapture({
              captureAmountPence: safe.capturePence,
              farePlusTipPence: finalFarePence,
              requestedTipPence: safeTipPence,
            }).tipCollectedPence,
            tip_shortfall_pence: tipCollectedFromConfirmedCapture({
              captureAmountPence: safe.capturePence,
              farePlusTipPence: finalFarePence,
              requestedTipPence: safeTipPence,
            }).tipShortfallPence,
            message: "Provider captured; Payment Sessions persist failed — wallet not posted",
          });
        }
        let posting: PostCaptureSettlementResult = postingWalletMismatch({
          settlement_status: "FAILED",
          expectedPence: 0,
          postedPence: 0,
        });
        try {
          const coveredTip = tipCollectedFromConfirmedCapture({
            captureAmountPence: safe.capturePence,
            farePlusTipPence: finalFarePence,
            requestedTipPence: safeTipPence,
          });
          const { data: tripFresh } = await args.supabase
            .from("trips")
            .select("*")
            .eq("id", tripId)
            .maybeSingle();
          posting = await applyCanonicalSettlementAfterCapture({
            supabase: args.supabase,
            tripId,
            mode: "fresh_capture",
            trip: {
              ...(tripFresh ?? args.trip),
              final_fare_pence: resolvedFare.final_fare_pence,
              pickup_waiting_charge_pence: resolvedFare.arrival_waiting_charge_pence,
              stop_waiting_charge_pence: resolvedFare.stop_waiting_charge_pence,
              airport_charge_pence: resolvedFare.airport_charge_pence,
              tip_pence: coveredTip.tipCollectedPence,
              tip_amount_pence: coveredTip.tipCollectedPence,
              driver_net_pence: (tripFresh ?? args.trip).driver_net_pence
                ?? args.trip.driver_net_pence,
              accepted_commission_percent: (tripFresh ?? args.trip).accepted_commission_percent
                ?? args.trip.accepted_commission_percent,
              driver_tier_commission_percent: (tripFresh ?? args.trip).driver_tier_commission_percent
                ?? args.trip.driver_tier_commission_percent,
              commission_pct: (tripFresh ?? args.trip).commission_pct
                ?? args.trip.commission_pct,
            },
            captureAmountPence: safe.capturePence,
            tipPence: coveredTip.tipCollectedPence,
          });
        } catch (ledgerErr) {
          console.error("[revolutCompletionCapture] increment safe-capture settlement failed", ledgerErr);
          posting = postingWalletMismatch({
            settlement_status: "FAILED",
            expectedPence: Math.round(Number(args.trip.driver_net_pence) || 0),
            postedPence: 0,
          });
        }
        if (safe.shortfallPence > 0) {
          await markPaymentSessionPaymentShortfall(args.supabase, {
            clientActionId,
            tripId,
            shortfallPence: safe.shortfallPence,
            reason:
              `Increment ${incrementResult.kind}; captured safe ${safe.capturePence}p; shortfall ${safe.shortfallPence}p only`,
          });
        }
        const coveredSafe = tipCollectedFromConfirmedCapture({
          captureAmountPence: safe.capturePence,
          farePlusTipPence: finalFarePence,
          requestedTipPence: safeTipPence,
        });
        return capturedWithPosting({
          success: true,
          status: safe.shortfallPence > 0 ? "PARTIAL_CAPTURE_ONLY" : "captured",
          capture_amount_pence: safe.capturePence,
          provider_order_id: orderId,
          tip_collected_pence: coveredSafe.tipCollectedPence,
          tip_shortfall_pence: coveredSafe.tipShortfallPence,
          message: safe.shortfallPence > 0
            ? `Captured ${safe.capturePence}p; remaining shortfall ${safe.shortfallPence}p only`
            : undefined,
        }, posting);
      } catch (capErr) {
        return {
          success: false,
          status: "capture_failed",
          capture_amount_pence: 0,
          provider_order_id: orderId,
          error: (capErr as Error).message,
        };
      } finally {
        if (!safeCapturedOk) {
          await releasePaymentSessionFinancialLock(args.supabase, {
            paymentSessionId: String(paymentSession.id),
            owner: `capture:${tripId}`,
            nextState: "IDLE",
          }).catch(() => undefined);
        } else {
          await releasePaymentSessionFinancialLock(args.supabase, {
            paymentSessionId: String(paymentSession.id),
            owner: `capture:${tripId}`,
            nextState: "CAPTURED",
          }).catch(() => undefined);
        }
      }
    } else {
      return {
        success: false,
        status: incrementResult.kind === "customer_action_required"
          ? "ADDITIONAL_AUTHORISATION_ACTION_REQUIRED"
          : "ADDITIONAL_AUTHORISATION_UNKNOWN",
        capture_amount_pence: 0,
        provider_order_id: orderId,
        error: incrementResult.message,
      };
    }
  }

  if (plan.kind === "additional_authorisation_required") {
    // Must not be reached while preferSameOrderIncrement is on.
    // Do not default to capturing the original hold — that skips increment.
    return {
      success: false,
      status: "ADDITIONAL_AUTHORISATION_UNKNOWN",
      capture_amount_pence: 0,
      provider_order_id: orderId,
      error:
        "Same-order increment is required before capture; original-hold capture is not the primary path.",
    };
  }

  if ((plan as { kind: string }).kind === "rehold_required") {
    return {
      success: false,
      status: "ADDITIONAL_AUTHORISATION_UNKNOWN",
      capture_amount_pence: 0,
      provider_order_id: orderId,
      message: "Legacy rehold_required path removed — increment same order first",
    };
  }

  if (plan.kind === "same_order_increment_required") {
    return {
      success: false,
      status: "ADDITIONAL_AUTHORISATION_UNKNOWN",
      capture_amount_pence: 0,
      provider_order_id: orderId,
      error:
        "Increment did not confirm an authorised total covering the final fare; reconcile before capture.",
    };
  }

  if (plan.kind !== "capture_within_hold") {
    return {
      success: false,
      status: "ADDITIONAL_AUTHORISATION_UNKNOWN",
      capture_amount_pence: 0,
      provider_order_id: orderId,
      error: `Unexpected capture plan kind: ${(plan as { kind: string }).kind}`,
    };
  }

  const amountToCapture = plan.capture_amount_pence;

  const tipCoverageFor = (capturedPence: number) =>
    tipCollectedFromConfirmedCapture({
      captureAmountPence: capturedPence,
      farePlusTipPence: finalFarePence,
      requestedTipPence: safeTipPence,
    });

  const ensurePostCaptureSettlement = async (
    captureAmountPence: number,
  ): Promise<PostCaptureSettlementResult> => {
    const coveredTip = tipCoverageFor(captureAmountPence).tipCollectedPence;
    try {
      const { data: tripFresh } = await args.supabase
        .from("trips")
        .select("*")
        .eq("id", tripId)
        .maybeSingle();
      return await applyCanonicalSettlementAfterCapture({
        supabase: args.supabase,
        tripId,
        mode: "fresh_capture",
        trip: {
          ...(tripFresh ?? args.trip),
          final_fare_pence: resolvedFare.final_fare_pence,
          pickup_waiting_charge_pence: resolvedFare.arrival_waiting_charge_pence,
          stop_waiting_charge_pence: resolvedFare.stop_waiting_charge_pence,
          airport_charge_pence: resolvedFare.airport_charge_pence,
          tip_pence: coveredTip,
          tip_amount_pence: coveredTip,
          driver_net_pence: (tripFresh ?? args.trip).driver_net_pence
            ?? args.trip.driver_net_pence,
          accepted_commission_percent: (tripFresh ?? args.trip).accepted_commission_percent
            ?? args.trip.accepted_commission_percent,
          driver_tier_commission_percent: (tripFresh ?? args.trip).driver_tier_commission_percent
            ?? args.trip.driver_tier_commission_percent,
          commission_pct: (tripFresh ?? args.trip).commission_pct
            ?? args.trip.commission_pct,
        },
        captureAmountPence,
        tipPence: coveredTip,
      });
    } catch (ledgerErr) {
      console.error("[revolutCompletionCapture] post-capture settlement failed", ledgerErr);
      return postingWalletMismatch({
        settlement_status: "FAILED",
        expectedPence: Math.round(Number(args.trip.driver_net_pence) || 0),
        postedPence: 0,
      });
    }
  };

  const { data: captureSessionByOrder } = await args.supabase
    .from("payment_sessions")
    .select("id")
    .eq("provider_order_id", orderId)
    .neq("purpose", "PAYMENT_RECOVERY")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  let captureSessionId = captureSessionByOrder?.id ? String(captureSessionByOrder.id) : null;
  if (!captureSessionId) {
    const { data: captureSessionByTrip } = await args.supabase
      .from("payment_sessions")
      .select("id")
      .eq("trip_id", tripId)
      .neq("purpose", "PAYMENT_RECOVERY")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    captureSessionId = captureSessionByTrip?.id ? String(captureSessionByTrip.id) : null;
  }
  const captureOwner = `capture:${tripId}`;

  if (captureSessionId) {
    const lock = await claimPaymentSessionFinancialLock(args.supabase, {
      paymentSessionId: captureSessionId,
      owner: captureOwner,
      state: "CAPTURING",
      operationKey: `capture:${orderId}:${amountToCapture}`,
    });
    if (!lock.ok) {
      return {
        success: false,
        status: "capture_busy",
        capture_amount_pence: 0,
        provider_order_id: orderId,
        error: `Financial operation busy (${lock.currentState ?? "unknown"}); capture not started`,
      };
    }

    let capturedOk = false;
    try {
      const orderFresh = await retrieveRevolutOrder(
        merchant.environment,
        merchant.secretKey,
        orderId,
      );
      const decision = decideCaptureAfterRetrieve({
        paymentSessionId: captureSessionId,
        providerOrderId: orderId,
        order: orderFresh,
        finalFarePence: amountToCapture,
      });

      if (decision.action === "reconcile_already_captured") {
        console.log(JSON.stringify({
          event: "duplicate_capture_prevented",
          trip_id: tripId,
          provider_order_id: `${orderId.slice(0, 4)}…${orderId.slice(-4)}`,
          capture_amount_pence: decision.captureAmountPence,
          business_key: decision.businessKey,
        }));
        const nowRec = new Date().toISOString();
        await markPaymentSessionCaptured(args.supabase, {
          clientActionId,
          providerOrderId: orderId,
          tripId,
          captureAmountPence: decision.captureAmountPence,
          capturedAt: nowRec,
          providerCaptureId: extractProviderCaptureId(
            orderFresh as unknown as Record<string, unknown>,
          ),
        });
        await releasePaymentSessionFinancialLock(args.supabase, {
          paymentSessionId: captureSessionId,
          owner: captureOwner,
          nextState: "CAPTURED",
        });
        capturedOk = true;
        const covered = tipCoverageFor(decision.captureAmountPence);
        const posting = await ensurePostCaptureSettlement(decision.captureAmountPence);
        return capturedWithPosting({
          success: true,
          status: "captured",
          capture_amount_pence: decision.captureAmountPence,
          provider_order_id: orderId,
          tip_collected_pence: covered.tipCollectedPence,
          tip_shortfall_pence: covered.tipShortfallPence,
          message: "Provider already captured; reconciled without re-capture",
        }, posting);
      }

      if (decision.action === "wait_processing") {
        return {
          success: false,
          status: "processing",
          capture_amount_pence: 0,
          provider_order_id: orderId,
          error: "Capture already processing at provider; wait and reconcile",
        };
      }

      if (decision.action === "shortfall_unusable") {
        return {
          success: false,
          status: "PAYMENT_RECOVERY_REQUIRED",
          capture_amount_pence: 0,
          provider_order_id: orderId,
          error: `Order unusable for capture (${decision.providerState})`,
        };
      }

      if (decision.action === "blocked_above_authorised") {
        return {
          success: false,
          status: "ADDITIONAL_AUTHORISATION_REQUIRED",
          capture_amount_pence: 0,
          provider_order_id: orderId,
          error: "Final fare exceeds provider-confirmed authorised total after retrieve",
        };
      }

      const blockedLocked = await refuseDifferentFinalCapture(decision.captureAmountPence);
      if (blockedLocked) return blockedLocked;
      const capturedLocked = await captureRevolutOrder(
        merchant.environment,
        merchant.secretKey,
        orderId,
        decision.captureAmountPence,
      );

      const paymentStatusLocked = mapRevolutStateToPaymentStatus(capturedLocked.state) ?? "captured";
      const nowLocked = new Date().toISOString();

      await args.supabase.from("trips").update({
        payment_status: paymentStatusLocked,
        payment_hold_status: "captured",
        capture_amount_pence: decision.captureAmountPence,
        final_fare_pence: resolvedFare.final_fare_pence,
        tip_pence: tipCoverageFor(decision.captureAmountPence).tipCollectedPence,
        tip_amount_pence: tipCoverageFor(decision.captureAmountPence).tipCollectedPence,
        pickup_waiting_charge_pence: resolvedFare.arrival_waiting_charge_pence,
        stop_waiting_charge_pence: resolvedFare.stop_waiting_charge_pence,
        total_waiting_charge_pence:
          resolvedFare.arrival_waiting_charge_pence + resolvedFare.stop_waiting_charge_pence,
        provider_charge_id: capturedLocked.id ?? orderId,
        updated_at: nowLocked,
      }).eq("id", tripId);

      await args.supabase.from("payments").update({
        status: paymentStatusLocked,
        captured_amount_pence: decision.captureAmountPence,
        provider_status: capturedLocked.state ?? null,
        updated_at: nowLocked,
      }).eq("provider_order_id", orderId);

      try {
        await markPaymentSessionCaptured(args.supabase, {
          clientActionId,
          providerOrderId: orderId,
          tripId,
          captureAmountPence: decision.captureAmountPence,
          authorisedAmountPence: authorisedHoldPence,
          totalAuthorisedAmountPence: authorisedHoldPence,
          resolutionFields: buildPaymentResolutionPersistPatch(fareAuthPlan, {
            captured_pence_override: decision.captureAmountPence,
            released_pence_override: fareAuthPlan.release_remainder_pence,
          }),
          capturedAt: nowLocked,
          providerCaptureId: extractProviderCaptureId(
            capturedLocked as unknown as Record<string, unknown>,
          ),
        });
      } catch (psErr) {
        console.error("[revolutCompletionCapture] Payment Sessions persist failed after provider capture", psErr);
        await recordPaymentSessionPersistFailureMetadata(args.supabase, {
          tripId,
          tripCode: args.trip.trip_code ? String(args.trip.trip_code) : null,
          errorMessage: psErr instanceof Error ? psErr.message : String(psErr),
        });
        await releasePaymentSessionFinancialLock(args.supabase, {
          paymentSessionId: captureSessionId,
          owner: captureOwner,
          nextState: "CAPTURED",
        });
        capturedOk = true;
        return capturedWalletNotPosted({
          success: true,
          status: paymentStatusLocked,
          capture_amount_pence: decision.captureAmountPence,
          provider_order_id: orderId,
          tip_collected_pence: tipCoverageFor(decision.captureAmountPence).tipCollectedPence,
          tip_shortfall_pence: tipCoverageFor(decision.captureAmountPence).tipShortfallPence,
          message: "Provider captured; Payment Sessions persist failed — wallet not posted",
        });
      }

      await releasePaymentSessionFinancialLock(args.supabase, {
        paymentSessionId: captureSessionId,
        owner: captureOwner,
        nextState: "CAPTURED",
      });
      capturedOk = true;
      const posting = await ensurePostCaptureSettlement(decision.captureAmountPence);
      const covered = tipCoverageFor(decision.captureAmountPence);
      return capturedWithPosting({
        success: true,
        status: paymentStatusLocked,
        capture_amount_pence: decision.captureAmountPence,
        provider_order_id: orderId,
        tip_collected_pence: covered.tipCollectedPence,
        tip_shortfall_pence: covered.tipShortfallPence,
      }, posting);
    } finally {
      if (!capturedOk) {
        await releasePaymentSessionFinancialLock(args.supabase, {
          paymentSessionId: captureSessionId,
          owner: captureOwner,
          nextState: "IDLE",
        }).catch(() => undefined);
      }
    }
  }

  const blockedUnguarded = await refuseDifferentFinalCapture(amountToCapture);
  if (blockedUnguarded) return blockedUnguarded;
  const captured = await captureRevolutOrder(
    merchant.environment,
    merchant.secretKey,
    orderId,
    amountToCapture,
  );

  const paymentStatus = mapRevolutStateToPaymentStatus(captured.state) ?? "captured";
  const now = new Date().toISOString();

  await args.supabase.from("trips").update({
    payment_status: paymentStatus,
    payment_hold_status: "captured",
    capture_amount_pence: amountToCapture,
    final_fare_pence: resolvedFare.final_fare_pence,
    tip_pence: tipCoverageFor(amountToCapture).tipCollectedPence,
    tip_amount_pence: tipCoverageFor(amountToCapture).tipCollectedPence,
    pickup_waiting_charge_pence: resolvedFare.arrival_waiting_charge_pence,
    stop_waiting_charge_pence: resolvedFare.stop_waiting_charge_pence,
    total_waiting_charge_pence:
      resolvedFare.arrival_waiting_charge_pence + resolvedFare.stop_waiting_charge_pence,
    provider_charge_id: captured.id ?? orderId,
    updated_at: now,
  }).eq("id", tripId);

  await args.supabase.from("payments").update({
    status: paymentStatus,
    captured_amount_pence: amountToCapture,
    provider_status: captured.state ?? null,
    updated_at: now,
  }).eq("provider_order_id", orderId);

  try {
    await markPaymentSessionCaptured(args.supabase, {
      clientActionId,
      providerOrderId: orderId,
      tripId,
      captureAmountPence: amountToCapture,
      authorisedAmountPence: authorisedHoldPence,
      totalAuthorisedAmountPence: authorisedHoldPence,
      resolutionFields: buildPaymentResolutionPersistPatch(fareAuthPlan, {
        captured_pence_override: amountToCapture,
        released_pence_override: fareAuthPlan.release_remainder_pence,
      }),
      capturedAt: now,
    });
  } catch (psErr) {
    console.error("[revolutCompletionCapture] Payment Sessions persist failed after provider capture", psErr);
    await recordPaymentSessionPersistFailureMetadata(args.supabase, {
      tripId,
      tripCode: args.trip.trip_code ? String(args.trip.trip_code) : null,
      errorMessage: psErr instanceof Error ? psErr.message : String(psErr),
    });
    return capturedWalletNotPosted({
      success: true,
      status: paymentStatus,
      capture_amount_pence: amountToCapture,
      provider_order_id: orderId,
      tip_collected_pence: tipCoverageFor(amountToCapture).tipCollectedPence,
      tip_shortfall_pence: tipCoverageFor(amountToCapture).tipShortfallPence,
      message: "Provider captured; Payment Sessions persist failed — wallet not posted",
    });
  }

  const residual = await persistPostCaptureResidualReleaseEvidence({
    supabase: args.supabase,
    clientActionId,
    providerOrderId: orderId,
    tripId,
    authorisedHoldPence: authorisedHoldPence,
    capturedAmountPence: amountToCapture,
    environment: merchant.environment,
    secretKey: merchant.secretKey,
    evidenceSource: RELEASE_EVIDENCE_SOURCE.REVOLUT_POST_CAPTURE_RETRIEVE,
  });

  const posting = paymentStatus === "captured"
    ? await ensurePostCaptureSettlement(amountToCapture)
    : postingWalletMismatch({
      settlement_status: "FAILED",
      expectedPence: 0,
      postedPence: 0,
    });

  return capturedWithPosting({
    success: true,
    status: paymentStatus,
    capture_amount_pence: amountToCapture,
    provider_order_id: orderId,
    tip_collected_pence: tipCoverageFor(amountToCapture).tipCollectedPence,
    tip_shortfall_pence: tipCoverageFor(amountToCapture).tipShortfallPence,
    message: residual.messageSuffix
      ? `Captured ${amountToCapture}p${residual.messageSuffix}`
      : "Revolut order capture requested",
  }, posting);
}