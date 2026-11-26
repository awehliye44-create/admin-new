/**
 * Immediate tip-window capture initiation (four-trigger settlement).
 *
 * Customer SKIP / SUBMIT_* must start the same finalize SSOT in-process so
 * trigger → CAPTURE claim stays within the engineering budget (~1s), instead of
 * paying a second Edge cold-start via HTTP invokeFinalizeTripCapture.
 *
 * Durable settlement outcome persistence matches HTTP finalize-trip-and-capture
 * (canonical durableSettlementOutcomeSSOT) — same-isolate must not leave
 * completed trips authorized+draft after a non-throwing finalize result.
 *
 * HTTP invoke remains the fallback when same-isolate capture throws, and for
 * workers that are not already holding the trip row / tip mutex.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  persistDurableSettlementOutcome,
  persistDurableSettlementOutcomeIfNeeded,
} from "./durableSettlementOutcomeSSOT.ts";
import { finalizeRevolutTripCapture } from "./finalizeRevolutTripCapture.ts";
import {
  invokeFinalizeTripCapture,
  type InvokeFinalizeTripCaptureResult,
} from "./invokeFinalizeTripCapture.ts";
import { resolveTrustedCaptureTipPence } from "./resolveTrustedCaptureTipPence.ts";
import type { AnySupabaseClient } from "./supabaseClientTypes.ts";
import { tripProviderOrderId } from "./tripPaymentProviderSSOT.ts";

export type TipWindowImmediateFinalizeArgs = {
  supabase: SupabaseClient;
  supabaseUrl: string;
  serviceRoleKey: string;
  tripId: string;
  tipPence: number;
  /** Audit source — submit_customer_trip_tip | capture_expired_tip_windows | … */
  source: string;
  /**
   * Tip submit captures while the window is processing/open.
   * Expiry callers pass false (window already past expires_at / claim held).
   */
  allowOpenTipWindow: boolean;
  /** Optional preloaded trip row — avoids a round-trip when caller already has it. */
  trip?: Record<string, unknown> | null;
};

function asInvokeResult(
  body: Record<string, unknown>,
): InvokeFinalizeTripCaptureResult {
  const status = String(body.status ?? "").toLowerCase();
  const durableSettlement =
    status.includes("shortfall") ||
    status.includes("recovery") ||
    status.includes("partial_capture") ||
    status.includes("additional_authorisation") ||
    status.includes("incremental") ||
    status === "capture_pending" ||
    status === "processing" ||
    status === "capture_busy";
  const businessOk = durableSettlement
    ? body.deferred !== true
    : body.success !== false && !body.error && body.deferred !== true;
  return {
    ok: businessOk,
    body,
    httpStatus: businessOk ? 200 : 400,
    attempts: 1,
    error: businessOk
      ? undefined
      : (typeof body.error === "string"
        ? body.error
        : typeof body.message === "string"
        ? body.message
        : status || "capture_not_confirmed"),
  };
}

/**
 * Prefer same-isolate finalizeRevolutTripCapture; fall back to HTTP invoke.
 * Logs tip_capture_initiated immediately so trigger→initiation is measurable.
 */
export async function finalizeTipWindowCaptureImmediate(
  args: TipWindowImmediateFinalizeArgs,
): Promise<InvokeFinalizeTripCaptureResult> {
  const bodyTipPence = Math.max(0, Math.round(Number(args.tipPence) || 0));
  const startedMs = Date.now();
  const db = args.supabase as AnySupabaseClient;

  console.log("[PAYMENT_AUDIT]", JSON.stringify({
    stage: "tip_capture_initiated",
    trip_id: args.tripId,
    tip_amount_pence: bodyTipPence,
    source: args.source,
    path: "same_isolate",
  }));

  try {
    let trip = args.trip ?? null;
    if (!trip) {
      const { data, error } = await args.supabase
        .from("trips")
        .select("*")
        .eq("id", args.tripId)
        .maybeSingle();
      if (error || !data) {
        throw new Error(error?.message ?? "Trip not found");
      }
      trip = data as Record<string, unknown>;
    }

    if (String(trip.status ?? "").toLowerCase() !== "completed") {
      return asInvokeResult({
        success: false,
        status: "trip_not_completed",
        error: "Trip must be completed before capture",
        capture_amount_pence: 0,
      });
    }

    if (
      String(trip.financial_model ?? "").toUpperCase() ===
        "DRIVER_COLLECTED_COMMISSION_WALLET"
    ) {
      return asInvokeResult({
        success: false,
        status: "financial_model_violation",
        error_code: "FINANCIAL_MODEL_VIOLATION",
        error:
          "FINANCIAL_MODEL_VIOLATION: platform capture forbidden on DRIVER_COLLECTED_COMMISSION_WALLET",
        capture_amount_pence: 0,
      });
    }

    const tipPence = resolveTrustedCaptureTipPence({
      source: args.source,
      bodyTipPence,
      trip,
    });

    const provider = String(trip.payment_provider ?? "").toLowerCase();
    const orderId = tripProviderOrderId(trip);
    if (provider !== "revolut" && !orderId) {
      await persistDurableSettlementOutcome(
        db,
        args.tripId,
        "provider_authorisation_missing",
        false,
      );
      return asInvokeResult({
        success: false,
        status: "provider_authorisation_missing",
        error: "Trip has no Revolut provider order for capture",
        capture_amount_pence: 0,
      });
    }

    const revolutResult = await finalizeRevolutTripCapture({
      supabase: args.supabase,
      trip,
      tipPence,
      allowOpenTipWindow: args.allowOpenTipWindow,
    });

    await persistDurableSettlementOutcomeIfNeeded(
      db,
      args.tripId,
      Boolean(revolutResult.success),
      String(revolutResult.status ?? ""),
    );

    console.log("[PAYMENT_AUDIT]", JSON.stringify({
      stage: "tip_capture_same_isolate_done",
      trip_id: args.tripId,
      tip_amount_pence: tipPence,
      source: args.source,
      status: revolutResult.status,
      success: revolutResult.success,
      elapsed_ms: Date.now() - startedMs,
    }));

    return asInvokeResult(revolutResult as unknown as Record<string, unknown>);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn("[PAYMENT_AUDIT]", JSON.stringify({
      stage: "tip_capture_same_isolate_fallback_http",
      trip_id: args.tripId,
      tip_amount_pence: bodyTipPence,
      source: args.source,
      error: message,
      elapsed_ms: Date.now() - startedMs,
    }));

    // HTTP finalize persists durable outcomes (including catch capture_failed).
    return await invokeFinalizeTripCapture({
      supabaseUrl: args.supabaseUrl,
      serviceRoleKey: args.serviceRoleKey,
      tripId: args.tripId,
      tipPence: bodyTipPence,
      source: args.source,
    });
  }
}
