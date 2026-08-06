/**
 * P0 — Revolut trip completion capture with hold reconciliation.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import { planRevolutCompletionCapture } from "../../../shared/revolutPaymentHoldSSOT.ts";
import { computeCaptureAmount, resolveTripFare } from "./tripFareSSOT.ts";
import { resolveRevolutMerchantContext } from "./revolutMerchantContext.ts";
import {
  captureRevolutOrder,
  createRevolutOrder,
  mapRevolutStateToPaymentStatus,
  retrieveRevolutOrder,
} from "./revolutOrders.ts";
import { applyCanonicalSettlementAfterCapture } from "./applyCanonicalSettlementAfterCapture.ts";
import {
  markPaymentSessionCaptured,
  markPaymentSessionCaptureResidualRelease,
  markPaymentSessionCompletedPendingCapture,
  markPaymentSessionPaymentShortfall,
  markPaymentSessionAdditionalAuthorisationLifecycle,
  markPaymentSessionProviderFee,
} from "./paymentSessionSSOT.ts";
import { extractConfirmedCaptureAmountPence, extractProviderCaptureId } from "../../../shared/paymentHoldProviderTerminalPure.ts";
import { extractProviderFeePence } from "../../../shared/paymentCaptureEvidenceSSOT.ts";
import {
  RELEASE_EVIDENCE_SOURCE,
} from "../../../shared/paymentSessionReleaseEvidenceSSOT.ts";
import {
  assertCaptureWithinTotalAuthorised,
  classifyAdditionalAuthorisationNeed,
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

export async function executeRevolutTripCompletionCapture(args: {
  supabase: SupabaseClient;
  trip: Record<string, unknown>;
  tipPence?: number;
}): Promise<FinalizeRevolutCaptureResult> {
  const tripId = String(args.trip.id);
  const tripStatus = String(args.trip.status ?? "").toLowerCase();
  const orderId = String(args.trip.provider_order_id ?? args.trip.stripe_payment_intent_id ?? "").trim();
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
  const { revolutProviderAuthorisedTotalPence } = await import("./revolutOrders.ts");
  let authorisedHoldPence = Math.max(
    0,
    revolutProviderAuthorisedTotalPence(orderBefore)
      || Number(orderBefore.amount ?? args.trip.authorised_amount_pence ?? 0),
  );
  const bufferPence = Math.max(0, Number(args.trip.preauth_buffer_pence ?? 0));

  if (state === "COMPLETED") {
    const captureAmountPence = Number(
      extractConfirmedCaptureAmountPence(
        orderBefore as unknown as Record<string, unknown>,
        "COMPLETED",
      )
        ?? args.trip.capture_amount_pence
        ?? orderBefore.amount
        ?? finalFarePence,
    );
    const now = new Date().toISOString();
    let residualMsg = "";
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
      }).eq("trip_id", tripId).or(`stripe_payment_intent_id.eq.${orderId},provider_order_id.eq.${orderId}`);
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
      await applyCanonicalSettlementAfterCapture({
        supabase: args.supabase,
        tripId,
        trip: {
          ...args.trip,
          ...resolvedFare,
          final_fare_pence: resolvedFare.final_fare_pence,
          pickup_waiting_charge_pence: resolvedFare.arrival_waiting_charge_pence,
          stop_waiting_charge_pence: resolvedFare.stop_waiting_charge_pence,
        },
        captureAmountPence,
        tipPence: safeTipPence,
      });
    } catch (ledgerErr) {
      console.error("[revolutCompletionCapture] already_captured persist failed", ledgerErr);
    }
    return {
      success: true,
      status: "already_captured",
      capture_amount_pence: captureAmountPence,
      provider_order_id: orderId,
      message: `Revolut order already captured${residualMsg}`,
    };
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

    const { executeSameOrderIncrement } = await import("./executeSameOrderIncrementSSOT.ts");
    const { safeCaptureAfterIncrementDecline } = await import("./paymentRecoveryGuardSSOT.ts");
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
      try {
        const capturedSafe = await captureRevolutOrder(
          merchant.environment,
          merchant.secretKey,
          orderId,
          safe.capturePence,
        );
        const nowSafe = new Date().toISOString();
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
        if (safe.shortfallPence > 0) {
          await markPaymentSessionPaymentShortfall(args.supabase, {
            clientActionId,
            tripId,
            shortfallPence: safe.shortfallPence,
            reason:
              `Increment ${incrementResult.kind}; captured safe ${safe.capturePence}p; shortfall ${safe.shortfallPence}p only`,
          });
        }
        return {
          success: true,
          status: safe.shortfallPence > 0 ? "PARTIAL_CAPTURE_ONLY" : "captured",
          capture_amount_pence: safe.capturePence,
          provider_order_id: orderId,
          message: safe.shortfallPence > 0
            ? `Captured ${safe.capturePence}p; remaining shortfall ${safe.shortfallPence}p only`
            : undefined,
        };
      } catch (capErr) {
        return {
          success: false,
          status: "capture_failed",
          capture_amount_pence: 0,
          provider_order_id: orderId,
          error: (capErr as Error).message,
        };
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
    const need = classifyAdditionalAuthorisationNeed({
      finalFarePence,
      authorisedHoldPence,
    });
    await markPaymentSessionAdditionalAuthorisationLifecycle(args.supabase, {
      clientActionId,
      tripId,
      phase: "REQUIRED",
      previousProviderOrderId: orderId,
      previousAuthorisedPence: authorisedHoldPence,
      shortfallPence: need.shortfall_pence,
    });
    await markPaymentSessionAdditionalAuthorisationLifecycle(args.supabase, {
      clientActionId,
      tripId,
      phase: "PENDING",
      previousProviderOrderId: orderId,
      previousAuthorisedPence: authorisedHoldPence,
      shortfallPence: need.shortfall_pence,
    });

    // HARD RULE: never cancel the original hold before additional auth succeeds.
    try {
      const currency = String(args.trip.currency_code ?? orderBefore.currency ?? "GBP").toUpperCase();
      const additionalAmount = plan.additional_authorisation_pence;
      const newOrder = await createRevolutOrder({
        environment: merchant.environment,
        secretKey: merchant.secretKey,
        amountMinor: additionalAmount,
        currency,
        tripId,
        description: `ONECAB trip ${tripId} additional authorisation`,
        metadata: {
          type: "trip_completion_additional_auth",
          trip_id: tripId,
          ...(clientActionId ? { client_action_id: clientActionId } : {}),
          original_order_id: orderId,
          shortfall_pence: plan.shortfall_pence,
          keep_original_hold: true,
        },
      });
      const newState = String(newOrder.state ?? "").toUpperCase();
      if (newState !== "AUTHORISED" && newState !== "PROCESSING") {
        // SCA / pending — preserve original £ hold; do not mark cancelled.
        const recoveryPlan = markAdditionalAuthPendingOrRecovery(
          fareAuthPlan,
          newState === "PENDING" ? "pending_sca" : "failed",
        );
        await markPaymentSessionAdditionalAuthorisationLifecycle(args.supabase, {
          clientActionId,
          tripId,
          phase: "FAILED",
          previousProviderOrderId: orderId,
          previousAuthorisedPence: authorisedHoldPence,
          newProviderOrderId: newOrder.id,
          newProviderAuthorisedPence: additionalAmount,
          shortfallPence: plan.shortfall_pence,
          reason: `Additional authorisation not confirmed: ${newState}`,
          resolutionFields: buildPaymentResolutionPersistPatch(recoveryPlan),
        });
        await args.supabase.from("trips").update({
          payment_hold_status: "payment_shortfall",
          updated_at: new Date().toISOString(),
        }).eq("id", tripId);
        return {
          success: false,
          status: "PAYMENT_RECOVERY_REQUIRED",
          capture_amount_pence: 0,
          provider_order_id: orderId,
          message:
            `Additional authorisation pending (${newState}); original hold preserved`,
        };
      }

      const additionalAuthPence = Math.max(
        0,
        Math.round(Number(newOrder.amount ?? additionalAmount)),
      );
      const totalAuthorised = authorisedHoldPence + additionalAuthPence;
      const captureGate = assertCaptureWithinTotalAuthorised({
        totalAuthorisedPence: totalAuthorised,
        captureAmountPence: finalFarePence,
      });
      if (!captureGate.ok) {
        throw new Error(
          `CAPTURE_LIMIT_EXCEEDED: capture ${finalFarePence}p > total authorised ${totalAuthorised}p`,
        );
      }

      await markPaymentSessionAdditionalAuthorisationLifecycle(args.supabase, {
        clientActionId,
        tripId,
        phase: "CONFIRMED",
        previousProviderOrderId: orderId,
        previousAuthorisedPence: authorisedHoldPence,
        newProviderOrderId: newOrder.id,
        newProviderAuthorisedPence: additionalAuthPence,
        newProviderState: newState,
        shortfallPence: need.shortfall_pence,
      });

      // Capture original hold for its authorised amount, then shortfall order.
      const originalCapturePence = plan.capture_from_original_pence;
      const capturedOriginal = await captureRevolutOrder(
        merchant.environment,
        merchant.secretKey,
        orderId,
        originalCapturePence,
      );
      const capturedAdditional = await captureRevolutOrder(
        merchant.environment,
        merchant.secretKey,
        newOrder.id,
        plan.shortfall_pence,
      );
      const paymentStatus =
        mapRevolutStateToPaymentStatus(capturedAdditional.state)
        ?? mapRevolutStateToPaymentStatus(capturedOriginal.state)
        ?? "captured";
      const now = new Date().toISOString();
      await args.supabase.from("trips").update({
        provider_order_id: orderId,
        payment_hold_status: paymentStatus === "captured" ? "captured" : "payment_shortfall",
        payment_status: paymentStatus,
        capture_amount_pence: finalFarePence,
        final_fare_pence: resolvedFare.final_fare_pence,
        authorised_amount_pence: totalAuthorised,
        updated_at: now,
      }).eq("id", tripId);

      await markPaymentSessionAdditionalAuthorisationLifecycle(args.supabase, {
        clientActionId,
        tripId,
        phase: "CAPTURED",
        previousProviderOrderId: orderId,
        previousAuthorisedPence: authorisedHoldPence,
        newProviderOrderId: newOrder.id,
        newProviderAuthorisedPence: additionalAuthPence,
        newProviderState: String(capturedAdditional.state ?? newState),
        captureAmountPence: finalFarePence,
        shortfallPence: need.shortfall_pence,
      });

      await markPaymentSessionCaptured(args.supabase, {
        clientActionId,
        providerOrderId: orderId,
        tripId,
        captureAmountPence: finalFarePence,
        totalAuthorisedAmountPence: totalAuthorised,
        authorisedAmountPence: authorisedHoldPence,
        providerCaptureId: extractProviderCaptureId(
          capturedOriginal as unknown as Record<string, unknown>,
        ),
        resolutionFields: buildPaymentResolutionPersistPatch({
          ...fareAuthPlan,
          payment_resolution_status: PAYMENT_RESOLUTION_STATUS.FINANCIAL_COMPLETION,
          money: {
            ...fareAuthPlan.money,
            additional_authorised_pence: additionalAuthPence,
            total_authorised_pence: totalAuthorised,
            captured_pence: finalFarePence,
            shortfall_pence: plan.shortfall_pence,
          },
        }),
      });

      const residual = await persistPostCaptureResidualReleaseEvidence({
        supabase: args.supabase,
        clientActionId,
        providerOrderId: orderId,
        tripId,
        authorisedHoldPence: totalAuthorised,
        capturedAmountPence: finalFarePence,
        environment: merchant.environment,
        secretKey: merchant.secretKey,
        evidenceSource: RELEASE_EVIDENCE_SOURCE.REVOLUT_POST_CAPTURE_RETRIEVE,
      });

      if (paymentStatus === "captured") {
        try {
          await applyCanonicalSettlementAfterCapture({
            supabase: args.supabase,
            tripId,
            trip: {
              ...args.trip,
              final_fare_pence: resolvedFare.final_fare_pence,
              pickup_waiting_charge_pence: resolvedFare.arrival_waiting_charge_pence,
              stop_waiting_charge_pence: resolvedFare.stop_waiting_charge_pence,
              airport_charge_pence: resolvedFare.airport_charge_pence,
              tip_pence: safeTipPence,
              tip_amount_pence: safeTipPence,
            },
            captureAmountPence: finalFarePence,
            tipPence: safeTipPence,
          });
        } catch (ledgerErr) {
          console.error("[revolutCompletionCapture] additional-auth settlement failed", ledgerErr);
        }
      }

      return {
        success: true,
        status: paymentStatus,
        capture_amount_pence: finalFarePence,
        provider_order_id: orderId,
        message:
          `Revolut additional authorisation and capture completed (original hold preserved)${residual.messageSuffix}`,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await markPaymentSessionAdditionalAuthorisationLifecycle(args.supabase, {
        clientActionId,
        tripId,
        phase: "FAILED",
        previousProviderOrderId: orderId,
        previousAuthorisedPence: authorisedHoldPence,
        newProviderAuthorisedPence: plan.additional_authorisation_pence,
        shortfallPence: plan.shortfall_pence,
        reason: message,
        resolutionFields: buildPaymentResolutionPersistPatch(
          markAdditionalAuthPendingOrRecovery(fareAuthPlan, "failed"),
        ),
      });
      // Original hold must remain active — never cancel here.
      await args.supabase.from("trips").update({
        payment_hold_status: "payment_shortfall",
        updated_at: new Date().toISOString(),
      }).eq("id", tripId);
      await args.supabase.from("admin_payment_audit").insert({
        action: "revolut_payment_shortfall",
        provider: "revolut",
        provider_payment_id: orderId,
        trip_id: tripId,
        metadata: {
          shortfall_pence: plan.shortfall_pence,
          additional_authorisation_pence: plan.additional_authorisation_pence,
          keep_original_hold: true,
          additional_auth: true,
          error: message,
        },
      });
      return {
        success: false,
        status: "PAYMENT_RECOVERY_REQUIRED",
        capture_amount_pence: 0,
        provider_order_id: orderId,
        message: `Additional authorisation failed; original hold preserved: ${message}`,
      };
    }
  }

  // Dead code guard — plan kinds are exhaustive above / below for within-hold.
  if ((plan as { kind: string }).kind === "rehold_required") {
    return {
      success: false,
      status: "PAYMENT_RECOVERY_REQUIRED",
      capture_amount_pence: 0,
      provider_order_id: orderId,
      message: "Legacy rehold_required path removed — use additional_authorisation_required",
    };
  }

  if (plan.kind !== "capture_within_hold" && plan.kind !== "same_order_increment_required") {
    return {
      success: false,
      status: "PAYMENT_RECOVERY_REQUIRED",
      capture_amount_pence: 0,
      provider_order_id: orderId,
      error: `Unexpected capture plan kind: ${(plan as { kind: string }).kind}`,
    };
  }

  const amountToCapture = plan.capture_amount_pence;

  const { data: captureSession } = await args.supabase
    .from("payment_sessions")
    .select("id")
    .eq("provider_order_id", orderId)
    .neq("purpose", "PAYMENT_RECOVERY")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const captureSessionId = captureSession?.id ? String(captureSession.id) : null;
  const captureOwner = `capture:${tripId}`;

  if (captureSessionId) {
    const { claimPaymentSessionFinancialLock, releasePaymentSessionFinancialLock } =
      await import("./paymentSessionFinancialLockSSOT.ts");
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
      const { decideCaptureAfterRetrieve } = await import("./revolutCaptureIdempotencySSOT.ts");
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
        return {
          success: true,
          status: "captured",
          capture_amount_pence: decision.captureAmountPence,
          provider_order_id: orderId,
          message: "Provider already captured; reconciled without re-capture",
        };
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
        tip_pence: safeTipPence,
        tip_amount_pence: safeTipPence,
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
      }).eq("trip_id", tripId).or(`stripe_payment_intent_id.eq.${orderId},provider_order_id.eq.${orderId}`);

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

      await releasePaymentSessionFinancialLock(args.supabase, {
        paymentSessionId: captureSessionId,
        owner: captureOwner,
        nextState: "CAPTURED",
      });
      capturedOk = true;
      return {
        success: true,
        status: paymentStatusLocked,
        capture_amount_pence: decision.captureAmountPence,
        provider_order_id: orderId,
      };
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
    tip_pence: safeTipPence,
    tip_amount_pence: safeTipPence,
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
  }).eq("trip_id", tripId).or(`stripe_payment_intent_id.eq.${orderId},provider_order_id.eq.${orderId}`);

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
  });

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

  if (paymentStatus === "captured") {
    try {
      await applyCanonicalSettlementAfterCapture({
        supabase: args.supabase,
        tripId,
        trip: {
          ...args.trip,
          final_fare_pence: resolvedFare.final_fare_pence,
          pickup_waiting_charge_pence: resolvedFare.arrival_waiting_charge_pence,
          stop_waiting_charge_pence: resolvedFare.stop_waiting_charge_pence,
          airport_charge_pence: resolvedFare.airport_charge_pence,
          tip_pence: safeTipPence,
          tip_amount_pence: safeTipPence,
        },
        captureAmountPence: amountToCapture,
        tipPence: safeTipPence,
      });
    } catch (ledgerErr) {
      console.error("[revolutCompletionCapture] settlement/ledger ensure failed", ledgerErr);
    }
  }

  return {
    success: true,
    status: paymentStatus,
    capture_amount_pence: amountToCapture,
    provider_order_id: orderId,
    message: residual.messageSuffix
      ? `Captured ${amountToCapture}p${residual.messageSuffix}`
      : "Revolut order capture requested",
  };
}
