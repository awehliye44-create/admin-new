/**
 * Shared complete_trip capture outcome persistence.
 * Used by stop-workflow (inline fail-safe) and process-trip-capture-jobs.
 * Does not change Revolut capture rules — only maps finalize results to trip columns
 * and existing failure recovery helpers.
 *
 * Tip-capture outcomes must never be classified as fare payment_shortfall.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { recordTripCaptureFailure } from "./digitalPaymentCapture.ts";
import { handleQueuedTripAfterPaymentFailure } from "./stackedRideLifecycle.ts";
import { durableSettlementColumns } from "./durableSettlementOutcomeSSOT.ts";
import {
  isFareDurableRecoveryStatus,
  isFarePaymentShortfallStatus,
  isTipCaptureOutcomeStatus,
} from "./captureOutcomeClassificationSSOT.ts";

export type FinalizeTripCaptureInvokeResult = {
  ok: boolean;
  error?: string;
  body?: Record<string, unknown>;
};

export type CompleteTripCaptureApplied =
  | "ok"
  | "durable_recovery"
  | "capture_failed"
  | "tip_outcome";

function bodyStatusOf(result: FinalizeTripCaptureInvokeResult): string {
  return String(
    (result.body as { status?: string } | undefined)?.status ?? "",
  ).toLowerCase();
}

export async function applyCompleteTripCaptureOutcome(
  supabase: SupabaseClient,
  args: {
    tripId: string;
    driverId: string | null;
    providerOrderId: string | null;
    hasStackedTrip: boolean;
    finalizeResult: FinalizeTripCaptureInvokeResult;
  },
): Promise<{ applied: CompleteTripCaptureApplied }> {
  const { tripId, driverId, providerOrderId, hasStackedTrip, finalizeResult } =
    args;
  const bodyStatus = bodyStatusOf(finalizeResult);
  const bodyOkFlag =
    (finalizeResult.body as { success?: boolean } | undefined)?.success;

  // Tip outcomes: preserve tip-specific settlement columns. Never fare shortfall.
  if (isTipCaptureOutcomeStatus(bodyStatus)) {
    const cols = durableSettlementColumns(
      bodyStatus,
      Boolean(finalizeResult.ok || bodyOkFlag === true),
    );
    // Belt-and-braces: tip status must not land on payment_shortfall.
    const paymentStatus = cols.payment_status === "payment_shortfall"
      ? "authorized"
      : cols.payment_status;
    const holdStatus = cols.payment_hold_status.includes("shortfall") &&
        !cols.payment_hold_status.includes("tip")
      ? (bodyStatus || "tip_authorisation_declined")
      : cols.payment_hold_status;
    await supabase.from("trips").update({
      payment_status: paymentStatus,
      payment_hold_status: holdStatus,
      updated_at: new Date().toISOString(),
    }).eq("id", tripId);
    return { applied: "tip_outcome" };
  }

  if (!finalizeResult.ok) {
    console.error(
      "[complete-trip-capture] finalize-trip-and-capture failed:",
      finalizeResult.error,
    );
    const isDurableRecovery = isFareDurableRecoveryStatus(bodyStatus);

    const { data: freshPay } = await supabase
      .from("trips")
      .select("payment_status, payment_hold_status")
      .eq("id", tripId)
      .maybeSingle();
    const freshStatus = String(freshPay?.payment_status ?? "").toLowerCase();
    const freshHold = String(freshPay?.payment_hold_status ?? "").toLowerCase();
    const alreadyShortfall =
      freshStatus === "payment_shortfall" ||
      (freshHold.includes("shortfall") && !freshHold.includes("tip")) ||
      (freshHold.includes("recovery") && !freshHold.includes("tip"));

    if (isDurableRecovery || alreadyShortfall || bodyOkFlag === true) {
      const hold = isDurableRecovery
        ? (bodyStatus.includes("additional_authorisation") ||
            bodyStatus.includes("incremental")
          ? (bodyStatus.includes("fail")
            ? "incremental_authorisation_failed"
            : "incremental_authorisation_pending")
          : (bodyStatus || "payment_shortfall"))
        : (freshHold || "payment_shortfall");
      await supabase.from("trips").update({
        payment_status: alreadyShortfall || isFarePaymentShortfallStatus(bodyStatus)
          ? "payment_shortfall"
          : (bodyStatus.includes("fail") ? "capture_failed" : "authorized"),
        payment_hold_status: hold,
        updated_at: new Date().toISOString(),
      }).eq("id", tripId);
      return { applied: "durable_recovery" };
    }

    await recordTripCaptureFailure(
      supabase,
      tripId,
      finalizeResult.error ?? "Auto capture failed",
      providerOrderId,
    );
    // Durable settlement outcome — never leave authorized+draft after complete.
    await supabase.from("trips").update({
      payment_status: "capture_failed",
      payment_hold_status: "capture_failed",
      updated_at: new Date().toISOString(),
    }).eq("id", tripId);
    if (hasStackedTrip) {
      await handleQueuedTripAfterPaymentFailure(supabase, {
        currentTripId: tripId,
        driverId,
        paymentStatus: "capture_failed",
      });
    }
    return { applied: "capture_failed" };
  }

  console.log(
    "[complete-trip-capture] finalize-trip-and-capture invoked",
    finalizeResult.body,
  );
  if (isFareDurableRecoveryStatus(bodyStatus)) {
    const colsStatus = isFarePaymentShortfallStatus(bodyStatus)
      ? "payment_shortfall"
      : bodyStatus.includes("fail")
      ? "capture_failed"
      : "authorized";
    await supabase.from("trips").update({
      payment_status: colsStatus,
      payment_hold_status: bodyStatus.includes("additional_authorisation") ||
          bodyStatus.includes("incremental")
        ? (bodyStatus.includes("fail")
          ? "incremental_authorisation_failed"
          : "incremental_authorisation_pending")
        : bodyStatus,
      updated_at: new Date().toISOString(),
    }).eq("id", tripId);
    return { applied: "durable_recovery" };
  }
  return { applied: "ok" };
}
