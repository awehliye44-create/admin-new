/**
 * Backend-owned fare-increase payment + atomic apply.
 *
 * FARE → MONEY PROTECTION → TRIP mutation.
 * Customer App may display progress; it must not be the financial orchestrator.
 *
 * PLATFORM_COLLECTED only. DRIVER_COLLECTED must not enter Revolut increment.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  fetchTripAndBroadcastUpdated,
  invokePreauthUpdateOnModification,
  upsertTripRoutePolyline,
} from "./tripModificationApply.ts";
import {
  decideFromPreauthInvokeResult,
  isAlreadyAppliedModification,
  type ModificationPaymentGateDecision,
} from "./tripModificationPaymentGateSSOT.ts";
import { SERVICE_AREA_FINANCIAL_MODEL } from "./commissionWalletSSOT.ts";

export const CUSTOMER_PAYMENT_INCREMENT_UNRESOLVED =
  "CUSTOMER_PAYMENT_INCREMENT_UNRESOLVED";

function isCashPaymentMethod(method: unknown): boolean {
  const m = String(method ?? "").toLowerCase();
  return m === "cash" || m === "cash_only" || m.includes("cash");
}

export type FareIncreasePaymentResult = {
  success: boolean;
  requestId: string;
  status: string;
  paymentStatus: string | null;
  paymentPhase?: string;
  paymentProcessing?: boolean;
  tripUnchanged?: boolean;
  alreadyApplied?: boolean;
  alreadyConfirmed?: boolean;
  claimCode?: string;
  authorisedTotalPence?: number;
  requiredPayablePence?: number;
  error?: string;
  httpStatus: number;
  requiresApproval?: boolean;
  navigationImpacted?: boolean;
  trip?: Record<string, unknown> | null;
  tripUpdated?: Record<string, unknown> | null;
};

/** Canonical protected customer amount for PLATFORM_COLLECTED hold. */
export function resolveProtectedCustomerPayablePence(trip: Record<string, unknown>): number {
  const sessionTotal = Math.round(Number(
    (trip as { total_authorised_amount_pence?: unknown }).total_authorised_amount_pence ?? 0,
  ));
  const auth = Math.round(Number(trip.authorised_amount_pence ?? 0));
  const totalAuthCol = Math.round(Number(
    (trip as { total_authorized_amount_pence?: unknown }).total_authorized_amount_pence ?? 0,
  ));
  return Math.max(0, sessionTotal, auth, totalAuthCol);
}

export function resolveCommittedCustomerPayablePence(trip: Record<string, unknown>): number {
  const finalCust = Math.round(Number(trip.final_customer_fare_pence ?? 0));
  const finalFare = Math.round(Number(trip.final_fare_pence ?? 0));
  const estimated = Math.round(Number(trip.estimated_total_pence ?? 0));
  const locked = Math.round(Number(trip.locked_base_fare_pence ?? 0));
  return Math.max(0, finalCust, finalFare, estimated, locked);
}

/**
 * Execute increment SSOT then atomic claim+apply for a positive-delta modification.
 * Fail-closed: never mutates trip fare/stops unless protected >= revised payable.
 */
export async function executeFareIncreaseModificationPayment(
  supabase: SupabaseClient,
  args: {
    requestId: string;
    changeRequest: Record<string, unknown>;
    trip: Record<string, unknown>;
  },
): Promise<FareIncreasePaymentResult> {
  const { requestId, changeRequest, trip } = args;
  const financialModel = String(trip.financial_model ?? "").toUpperCase();

  if (isAlreadyAppliedModification(String(changeRequest.status ?? ""))) {
    return {
      success: true,
      requestId,
      status: String(changeRequest.status),
      paymentStatus: String(changeRequest.payment_status ?? "confirmed"),
      alreadyConfirmed: true,
      alreadyApplied: true,
      paymentPhase: "MODIFICATION_APPLIED",
      httpStatus: 200,
    };
  }

  const status = String(changeRequest.status ?? "");
  if (!["payment_required", "payment_pending", "payment_confirmed"].includes(status)) {
    if (["pending_driver_approval", "approved"].includes(status)) {
      return {
        success: true,
        requestId,
        status,
        paymentStatus: String(changeRequest.payment_status ?? "confirmed"),
        alreadyConfirmed: true,
        httpStatus: 200,
        requiresApproval: Boolean(changeRequest.requires_approval),
        navigationImpacted: Boolean(changeRequest.navigation_impacted),
      };
    }
    return {
      success: false,
      requestId,
      status,
      paymentStatus: String(changeRequest.payment_status ?? ""),
      error: "Request is not awaiting payment confirmation",
      httpStatus: 400,
      tripUnchanged: true,
    };
  }

  const fareDelta = Number(changeRequest.fare_delta_pence ?? 0);
  if (fareDelta <= 0) {
    const { data: advanced, error: advanceError } = await supabase.rpc(
      "advance_trip_change_after_payment",
      { p_request_id: requestId },
    );
    if (advanceError) {
      return {
        success: false,
        requestId,
        status: "payment_failed",
        paymentStatus: "failed",
        error: advanceError.message,
        httpStatus: 500,
        tripUnchanged: true,
      };
    }
    return {
      success: true,
      requestId,
      status: String((advanced as { status?: string } | null)?.status ?? "applied"),
      paymentStatus: "not_required",
      httpStatus: 200,
    };
  }

  // DRIVER_COLLECTED must never enter Revolut/Payment Sessions increment.
  if (financialModel === SERVICE_AREA_FINANCIAL_MODEL.DRIVER_COLLECTED_COMMISSION_WALLET) {
    return {
      success: false,
      requestId,
      status: "payment_failed",
      paymentStatus: "failed",
      error: "FINANCIAL_MODEL_VIOLATION: PLATFORM increment path forbidden on DRIVER_COLLECTED",
      httpStatus: 409,
      tripUnchanged: true,
    };
  }

  await supabase
    .from("trip_change_requests")
    .update({
      status: "payment_pending",
      payment_status: "pending",
      updated_at: new Date().toISOString(),
    })
    .eq("id", requestId)
    .in("status", ["payment_required", "payment_pending"]);

  const newFarePence = Number(
    changeRequest.new_fare_pence
      ?? trip.final_customer_fare_pence
      ?? trip.estimated_total_pence
      ?? 0,
  );

  if (!newFarePence || newFarePence <= 0) {
    await supabase
      .from("trip_change_requests")
      .update({
        status: "payment_failed",
        payment_status: "failed",
        rejection_reason: "Payable total missing for paid trip modification",
        updated_at: new Date().toISOString(),
      })
      .eq("id", requestId);
    return {
      success: false,
      requestId,
      status: "payment_failed",
      paymentStatus: "failed",
      error: "Payable total missing for paid trip modification",
      httpStatus: 402,
      tripUnchanged: true,
      requiredPayablePence: newFarePence,
    };
  }

  let gate: ModificationPaymentGateDecision = decideFromPreauthInvokeResult({
    success: false,
    requiredPayablePence: newFarePence,
    authorisedAmountPence: 0,
    paymentCoverageStatus: "authorization_insufficient",
  });

  if (isCashPaymentMethod(trip.payment_method)) {
    // PLATFORM_COLLECTED should not use operational cash; fail closed.
    await supabase
      .from("trip_change_requests")
      .update({
        status: "payment_failed",
        payment_status: "failed",
        rejection_reason: "platform_collected_cash_forbidden",
        updated_at: new Date().toISOString(),
      })
      .eq("id", requestId);
    return {
      success: false,
      requestId,
      status: "payment_failed",
      paymentStatus: "failed",
      error: "FINANCIAL_MODEL_VIOLATION: cash increment forbidden on PLATFORM_COLLECTED",
      httpStatus: 409,
      tripUnchanged: true,
    };
  }

  let preauthResult: Record<string, unknown> | null = null;
  try {
    preauthResult = await invokePreauthUpdateOnModification(
      supabase,
      String(trip.id),
      newFarePence,
    ) as Record<string, unknown> | null;
  } catch (invokeErr) {
    const message = invokeErr instanceof Error ? invokeErr.message : String(invokeErr);
    gate = decideFromPreauthInvokeResult({
      success: false,
      requiredPayablePence: newFarePence,
      authorisedAmountPence: 0,
      paymentCoverageStatus: "authorization_reconciliation_pending",
      errorCode: /timeout/i.test(message)
        ? "TIMEOUT"
        : /network|fetch/i.test(message)
        ? "NETWORK"
        : "AUTHORISATION_RECONCILIATION_PENDING",
      warning: message,
    });
    preauthResult = null;
  }

  if (preauthResult) {
    gate = decideFromPreauthInvokeResult({
      success: preauthResult.success === true,
      skipped: preauthResult.skipped === true,
      paymentCoverageStatus: typeof preauthResult.payment_coverage_status === "string"
        ? preauthResult.payment_coverage_status
        : null,
      authorisedAmountPence: Number(
        preauthResult.authorised_amount_pence
          ?? preauthResult.total_authorized_amount_pence
          ?? preauthResult.amount_capturable
          ?? 0,
      ),
      requiredPayablePence: newFarePence,
      errorCode: typeof preauthResult.error_code === "string"
        ? preauthResult.error_code
        : null,
      warning: typeof preauthResult.warning === "string"
        ? preauthResult.warning
        : typeof preauthResult.error === "string"
        ? preauthResult.error
        : null,
    });
  }

  // Fail closed: re-read canonical protected amount after provider result (#10–11).
  let sessionProtected = 0;
  if (trip.payment_session_id || trip.id) {
    const sessionQuery = supabase
      .from("payment_sessions")
      .select("authorised_amount_pence, total_authorised_amount_pence")
      .neq("purpose", "PAYMENT_RECOVERY")
      .order("created_at", { ascending: false })
      .limit(1);
    const { data: sessionRow } = trip.payment_session_id
      ? await sessionQuery.eq("id", String(trip.payment_session_id)).maybeSingle()
      : await sessionQuery.eq("trip_id", String(trip.id)).maybeSingle();
    sessionProtected = Math.max(
      0,
      Math.round(Number(sessionRow?.total_authorised_amount_pence ?? 0)),
      Math.round(Number(sessionRow?.authorised_amount_pence ?? 0)),
    );
  }
  const { data: freshTripAuth } = await supabase
    .from("trips")
    .select("authorised_amount_pence, total_authorized_amount_pence")
    .eq("id", trip.id)
    .maybeSingle();

  const protectedAfter = Math.max(
    gate.authorisedTotalPence,
    sessionProtected,
    resolveProtectedCustomerPayablePence({
      ...trip,
      authorised_amount_pence: freshTripAuth?.authorised_amount_pence
        ?? trip.authorised_amount_pence,
      total_authorized_amount_pence: freshTripAuth?.total_authorized_amount_pence
        ?? (trip as { total_authorized_amount_pence?: unknown }).total_authorized_amount_pence,
      total_authorised_amount_pence: sessionProtected,
    }),
  );
  if (gate.mayApply && protectedAfter < newFarePence) {
    gate = {
      phase: "PAYMENT_FAILED",
      mayApply: false,
      paymentStatus: "failed",
      requestStatus: "payment_failed",
      authorisedTotalPence: protectedAfter,
      reason: "amount_mismatch",
    };
  } else if (gate.mayApply) {
    gate = { ...gate, authorisedTotalPence: protectedAfter };
  }

  if (!gate.mayApply) {
    const pending = gate.phase === "PAYMENT_PENDING";
    await supabase
      .from("trip_change_requests")
      .update({
        status: gate.requestStatus,
        payment_status: gate.paymentStatus,
        rejection_reason: `payment_${gate.reason}`,
        updated_at: new Date().toISOString(),
      })
      .eq("id", requestId);

    return {
      success: false,
      requestId,
      status: gate.requestStatus,
      paymentStatus: gate.paymentStatus,
      paymentPhase: gate.phase,
      paymentProcessing: pending,
      tripUnchanged: true,
      authorisedTotalPence: gate.authorisedTotalPence,
      requiredPayablePence: newFarePence,
      error: pending
        ? "Payment is still processing. Your trip has not been changed."
        : "Payment confirmation failed",
      httpStatus: pending ? 202 : 402,
    };
  }

  const expectedPrevious = Number(changeRequest.original_fare_pence ?? 0);
  const expectedTripStatus = String(trip.status ?? "").toLowerCase();
  const { data: claimResult, error: claimError } = await supabase.rpc(
    "claim_and_apply_fare_increase_modification",
    {
      p_trip_id: trip.id,
      p_request_id: requestId,
      p_expected_original_fare_pence: expectedPrevious,
      p_expected_trip_status: expectedTripStatus,
      p_required_authorised_total_pence: newFarePence,
      p_provider_confirmed: true,
      p_authorised_total_pence: gate.authorisedTotalPence,
    },
  );

  if (claimError) {
    const msg = String(claimError.message ?? claimError.details ?? "");
    const code = msg.includes("ALREADY_APPLIED")
      ? "ALREADY_APPLIED"
      : msg.includes("PAYMENT_NOT_CONFIRMED")
      ? "PAYMENT_NOT_CONFIRMED"
      : msg.includes("STALE_MODIFICATION")
      ? "STALE_MODIFICATION"
      : "CLAIM_FAILED";

    if (code === "ALREADY_APPLIED") {
      return {
        success: true,
        requestId,
        status: "applied",
        paymentStatus: "confirmed",
        paymentPhase: "MODIFICATION_APPLIED",
        alreadyConfirmed: true,
        alreadyApplied: true,
        claimCode: code,
        httpStatus: 200,
      };
    }

    if (code === "PAYMENT_NOT_CONFIRMED") {
      await supabase
        .from("trip_change_requests")
        .update({
          status: "payment_pending",
          payment_status: "pending",
          rejection_reason: "payment_not_confirmed_at_claim",
          updated_at: new Date().toISOString(),
        })
        .eq("id", requestId)
        .in("status", ["payment_required", "payment_pending", "payment_confirmed"]);

      return {
        success: false,
        requestId,
        status: "payment_pending",
        paymentStatus: "pending",
        paymentPhase: "PAYMENT_PENDING",
        paymentProcessing: true,
        tripUnchanged: true,
        error: "Payment is still processing. Your trip has not been changed.",
        httpStatus: 202,
      };
    }

    return {
      success: false,
      requestId,
      status: "payment_failed",
      paymentStatus: "failed",
      claimCode: code,
      tripUnchanged: true,
      error: "Trip fare changed before this modification could apply. Re-check fare impact.",
      httpStatus: 409,
    };
  }

  const claim = (claimResult ?? {}) as Record<string, unknown>;
  const claimCode = String(claim.code ?? "MODIFICATION_APPLIED");
  const finalStatus = String(claim.request_status ?? "applied");

  let updatedTrip: Record<string, unknown> | null = null;
  let tripUpdated: Record<string, unknown> | null = null;

  if (
    claimCode === "MODIFICATION_APPLIED"
    || claimCode === "ALREADY_APPLIED"
    || finalStatus === "applied"
    || finalStatus === "approved"
  ) {
    const afterSnapshot = (changeRequest.after_route_snapshot ?? {}) as Record<string, unknown>;
    const farePreview = afterSnapshot.fare_preview as Record<string, unknown> | undefined;
    const polyline =
      typeof farePreview?.polyline === "string" ? farePreview.polyline : null;

    const broadcastResult = await fetchTripAndBroadcastUpdated(
      supabase,
      String(trip.id),
      polyline,
      { changeRequestId: requestId },
    );
    updatedTrip = broadcastResult?.trip ?? null;
    tripUpdated = broadcastResult?.payload ?? null;
    if (updatedTrip) {
      await upsertTripRoutePolyline(supabase, String(trip.id), polyline, updatedTrip);
    }
  }

  const { data: latest } = await supabase
    .from("trip_change_requests")
    .select("status, payment_status, requires_approval, navigation_impacted")
    .eq("id", requestId)
    .single();

  return {
    success: true,
    requestId,
    status: String(latest?.status ?? finalStatus),
    paymentStatus: String(latest?.payment_status ?? "confirmed"),
    paymentPhase: "MODIFICATION_APPLIED",
    claimCode,
    alreadyApplied: claimCode === "ALREADY_APPLIED",
    requiresApproval: Boolean(latest?.requires_approval),
    navigationImpacted: Boolean(latest?.navigation_impacted),
    authorisedTotalPence: gate.authorisedTotalPence,
    requiredPayablePence: newFarePence,
    trip: updatedTrip,
    tripUpdated,
    httpStatus: 200,
  };
}

/** Completion / capture fail-closed gate (race-safe via DB FOR UPDATE). */
export async function assertPlatformCollectedCompletionPaymentGate(
  supabase: SupabaseClient,
  tripId: string,
): Promise<{ ok: true; protectedPence?: number; requiredPence?: number } | {
  ok: false;
  code: string;
  message: string;
  protectedPence?: number;
  requiredPence?: number;
}> {
  const { data, error } = await supabase.rpc(
    "assert_trip_completion_customer_payment_gate",
    { p_trip_id: tripId },
  );
  if (error) {
    // Fail closed if completion gate RPC is unavailable — never soft-skip
    // protected >= committed (MK-260916-030).
    console.error("assert_trip_completion_customer_payment_gate failed", error);
    return {
      ok: false,
      code: "UNRESOLVED_MODIFICATION_CHECK_FAILED",
      message: "Unable to verify trip payment protection before completion",
    };
  }
  const row = (data ?? {}) as Record<string, unknown>;
  if (row.ok === true) {
    return {
      ok: true,
      protectedPence: Number(row.protected_pence ?? 0) || undefined,
      requiredPence: Number(row.required_pence ?? 0) || undefined,
    };
  }
  return {
    ok: false,
    code: String(row.code ?? CUSTOMER_PAYMENT_INCREMENT_UNRESOLVED),
    message: String(
      row.message
        ?? "Trip has an unresolved customer payment increment; completion is blocked",
    ),
    protectedPence: Number(row.protected_pence ?? 0) || undefined,
    requiredPence: Number(row.required_pence ?? 0) || undefined,
  };
}

/** @deprecated Prefer assertPlatformCollectedCompletionPaymentGate */
export async function assertNoUnresolvedFareIncreaseModification(
  supabase: SupabaseClient,
  tripId: string,
): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
  const { data: unresolved, error } = await supabase.rpc(
    "trip_has_unresolved_fare_increase_modification",
    { p_trip_id: tripId },
  );
  if (error) {
    return {
      ok: false,
      code: "UNRESOLVED_MODIFICATION_CHECK_FAILED",
      message: "Unable to verify trip modifications before completion",
    };
  }
  if (unresolved === true) {
    return {
      ok: false,
      code: CUSTOMER_PAYMENT_INCREMENT_UNRESOLVED,
      message:
        "Trip has an unresolved customer payment increment; completion is blocked",
    };
  }
  return { ok: true };
}
