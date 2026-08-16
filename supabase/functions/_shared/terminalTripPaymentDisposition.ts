/**
 * Terminal trip payment disposition SSOT.
 *
 * Open authorisations may remain only while a trip is dispatchable, rematching
 * (searching_new_driver), assigned before Start Trip, or in progress under the
 * approved capture lifecycle.
 *
 * Fee decision owner: terminalFeeDecisionSSOT.resolveTerminalPaymentDecision
 * Completed-trip settlement is never routed through this module.
 *
 * For terminal non-completed outcomes:
 *   - fee = 0  → void/cancel full Revolut authorisation
 *   - fee > 0  → partial capture fee only (Revolut releases remainder)
 *
 * Rematch / active / completed: do not void here.
 * Start Trip without completion: skip (interrupted-trip policy not invented here).
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  cancelRevolutOrder,
  captureRevolutOrder,
  retrieveRevolutOrder,
  getRevolutMerchantConfig,
  mapRevolutStateToPaymentStatus,
} from "./revolutOrders.ts";
import {
  assertHoldReleaseAllowed,
  stampReleaseTrigger,
  type HoldReleaseTrigger,
} from "./paymentHoldGuard.ts";
import { resolveTripPaymentProvider, tripProviderOrderId } from "./tripPaymentProviderSSOT.ts";
import {
  resolveTerminalPaymentDecision,
  type FarePricingFeeConfig,
  type TerminalPaymentDecision,
} from "./terminalFeeDecisionSSOT.ts";

export type { TerminalPaymentDecision, FarePricingFeeConfig } from "./terminalFeeDecisionSSOT.ts";
export { resolveTerminalPaymentDecision } from "./terminalFeeDecisionSSOT.ts";

const TERMINAL_NON_COMPLETED = new Set([
  "cancelled",
  "canceled",
  "customer_cancelled",
  "driver_cancelled",
  "expired",
  "expired_no_driver",
  "no_show",
  "failed",
  "declined",
]);

const KEEP_AUTH_STATUSES = new Set([
  "searching",
  "searching_new_driver",
  "broadcasting",
  "offered",
  "offering",
  "negotiating",
  "pending",
  "payment_pending",
  "driver_assigned",
  "accepted",
  "confirmed",
  "queued",
  "en_route",
  "en_route_to_pickup",
  "driver_en_route",
  "arrived",
  "arrived_at_pickup",
  "at_pickup",
  "waiting",
  "pickup_waiting",
  "in_progress",
  "on_trip",
  "started",
  "ongoing",
  "completing",
  "completed",
]);

const OPEN_PROVIDER = new Set(["AUTHORISED", "AUTHORIZED", "PENDING", "PROCESSING"]);
const RELEASED_PROVIDER = new Set(["CANCELLED", "CANCELED", "FAILED", "EXPIRED"]);

export type TerminalDispositionReason =
  | "customer_cancel"
  | "admin_cancel"
  | "driver_cancel_terminal"
  | "search_expired"
  | "scheduled_expired"
  | "booking_failed_after_auth"
  | "rematch_expired"
  | "sweep_fallback"
  | "manual_remediation";

export type TerminalDispositionOutcome =
  | "RELEASED_AND_RECONCILED"
  | "ALREADY_RELEASED_RECONCILED"
  | "FEE_CAPTURED_AND_REMAINDER_RELEASED"
  | "SKIPPED_REMATCH_OR_ACTIVE"
  | "SKIPPED_COMPLETED"
  | "SKIPPED_NO_ORDER"
  | "SKIPPED_NOT_REVOLUT"
  | "SKIPPED_SAFETY_CHECK"
  | "SKIPPED_STARTED_MISSING_INTERRUPTED_POLICY"
  | "PROVIDER_PENDING_RECONCILIATION"
  | "PROVIDER_FAILED"
  | "LOCAL_RECONCILIATION_FAILED_AFTER_PROVIDER_SUCCESS"
  | "HOLD_PROTECTED";

export type TerminalDispositionResult = {
  outcome: TerminalDispositionOutcome;
  trip_id: string;
  provider_order_id_mask?: string;
  provider_state?: string;
  authorised_pence?: number;
  captured_fee_pence?: number;
  released_pence?: number;
  message?: string;
  disposition_key: string;
  decision?: TerminalPaymentDecision;
};

function maskOrderId(id: string | null | undefined): string | undefined {
  if (!id) return undefined;
  if (id.length <= 12) return `${id.slice(0, 4)}…`;
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}

function normalizeStatus(raw: string | null | undefined): string {
  return String(raw ?? "").trim().toLowerCase().replace(/-/g, "_");
}

/** Pure eligibility — used by unit tests and the live disposer. */
export function classifyTerminalHoldDisposition(args: {
  tripStatus: string | null | undefined;
  startedAt?: string | null;
  feePence?: number | null;
  hasProviderOrder: boolean;
  provider?: string | null;
}): {
  action: "void_full" | "partial_capture_fee" | "skip";
  outcome?: TerminalDispositionOutcome;
  reason?: string;
} {
  const status = normalizeStatus(args.tripStatus);
  if (status === "completed") {
    return { action: "skip", outcome: "SKIPPED_COMPLETED", reason: "completed_trip" };
  }
  if (KEEP_AUTH_STATUSES.has(status) && !TERMINAL_NON_COMPLETED.has(status)) {
    return { action: "skip", outcome: "SKIPPED_REMATCH_OR_ACTIVE", reason: `status=${status}` };
  }
  if (!TERMINAL_NON_COMPLETED.has(status)) {
    return { action: "skip", outcome: "SKIPPED_REMATCH_OR_ACTIVE", reason: `non_terminal=${status}` };
  }
  // started_at no longer blocks void/partial-fee: terminal cancel after Start Trip
  // must release uncaptured auth when fee=0 (or partial-capture fee when fee>0).
  // Mid-ride full settlement remains out of scope (completed path only).
  void args.startedAt;
  if (!args.hasProviderOrder) {
    return { action: "skip", outcome: "SKIPPED_NO_ORDER", reason: "missing_provider_order" };
  }
  if (args.provider && args.provider !== "revolut") {
    return { action: "skip", outcome: "SKIPPED_NOT_REVOLUT", reason: `provider=${args.provider}` };
  }
  const fee = Math.max(0, Math.round(Number(args.feePence ?? 0)));
  if (fee > 0) return { action: "partial_capture_fee" };
  return { action: "void_full" };
}

const FPS_SELECT =
  "id, cancellation_fee_pence, cancellation_grace_period_minutes, cancellation_apply_after_arrival_only, no_show_fee_pence, no_show_wait_time_minutes, no_show_apply_after_arrival_only, late_cancel_enabled, late_cancel_threshold_minutes, late_cancel_fee_pence, arrival_cancellation_enabled, arrival_cancellation_fee_pence, arrival_cancellation_apply_after_free_waiting_expired, arrival_cancellation_after_arrival_only, free_waiting_minutes";

async function loadFarePricingFeeConfig(
  supabase: SupabaseClient,
  serviceAreaId: string | null | undefined,
  vehicleTypeId: string | null | undefined,
): Promise<{ config: FarePricingFeeConfig | null; feePolicyId: string | null }> {
  if (!serviceAreaId) return { config: null, feePolicyId: null };
  let q = supabase
    .from("fare_pricing_settings")
    .select(FPS_SELECT)
    .eq("service_area_id", serviceAreaId);
  if (vehicleTypeId) q = q.eq("vehicle_type_id", vehicleTypeId);
  const { data } = await q.maybeSingle();
  if (!data && vehicleTypeId) {
    const { data: fallback } = await supabase
      .from("fare_pricing_settings")
      .select(FPS_SELECT)
      .eq("service_area_id", serviceAreaId)
      .is("vehicle_type_id", null)
      .maybeSingle();
    if (!fallback) return { config: null, feePolicyId: null };
    return { config: fallback as FarePricingFeeConfig, feePolicyId: (fallback as { id: string }).id };
  }
  if (!data) return { config: null, feePolicyId: null };
  return { config: data as FarePricingFeeConfig, feePolicyId: (data as { id: string }).id };
}

function mapReasonToReleaseTrigger(reason: TerminalDispositionReason): HoldReleaseTrigger {
  // Compatible with existing DB trigger allowlist. Migration may add finer triggers later.
  if (reason === "manual_remediation" || reason === "sweep_fallback") {
    return "admin_abandon_recovery";
  }
  return "admin_abandon_recovery";
}

async function reconcileSessionCancelled(
  supabase: SupabaseClient,
  args: {
    sessionId: string;
    tripId: string;
    orderId: string;
    authPence: number;
    providerState: string;
    dispositionKey: string;
    capturedFeePence?: number;
  },
): Promise<boolean> {
  const { sessionId, tripId, orderId, authPence, providerState, dispositionKey, capturedFeePence = 0 } = args;
  const released = Math.max(0, authPence - capturedFeePence);

  // provider_state first (prevent_authorised_session_client_cancel)
  const { error: e1 } = await supabase
    .from("payment_sessions")
    .update({
      provider_state: providerState,
      captured_amount_pence: capturedFeePence,
      released_amount_pence: released,
      released_at: new Date().toISOString(),
      provider_state_verified_at: new Date().toISOString(),
      provider_state_verified_by: "terminal_disposition",
      updated_at: new Date().toISOString(),
    })
    .eq("id", sessionId)
    .eq("trip_id", tripId)
    .eq("provider_order_id", orderId);

  if (e1) {
    console.error("[terminalDisposition] provider_state update failed", e1);
    return false;
  }

  const { error: e2 } = await supabase
    .from("payment_sessions")
    .update({
      status: "cancelled",
      hold_release_state: "released",
      hold_terminal_reason: capturedFeePence > 0 ? "terminal_fee_partial_capture" : "terminal_no_fee_void",
      release_evidence_status: "CONFIRMED",
      release_evidence_source: "revolut_merchant_get_order",
      release_verified_at: new Date().toISOString(),
      provider_release_reference: orderId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", sessionId)
    .eq("provider_state", providerState);

  if (e2) {
    console.error("[terminalDisposition] status update failed", e2);
    return false;
  }

  await supabase
    .from("trips")
    .update({
      payment_status: capturedFeePence > 0
        ? (mapRevolutStateToPaymentStatus("COMPLETED") ?? "captured")
        : "cancelled",
      capture_amount_pence: capturedFeePence,
      updated_at: new Date().toISOString(),
    })
    .eq("id", tripId);

  await supabase.from("admin_payment_audit").insert({
    trip_id: tripId,
    action: capturedFeePence > 0 ? "capture" : "hold_release_succeeded",
    reason: `Terminal disposition ${dispositionKey}`,
    amount_pence_before: authPence,
    amount_pence_after: capturedFeePence,
    delta_pence: capturedFeePence - authPence,
    provider: "revolut",
    provider_payment_id: orderId,
    metadata: {
      disposition_key: dispositionKey,
      provider_state: providerState,
      captured_fee_pence: capturedFeePence,
      released_pence: released,
    },
  });

  return true;
}

async function markDispositionFinal(
  supabase: SupabaseClient,
  sessionId: string,
  priorMeta: Record<string, unknown>,
  dispositionKey: string,
  decision: TerminalPaymentDecision,
): Promise<void> {
  await supabase.from("payment_sessions").update({
    metadata: {
      ...priorMeta,
      terminal_disposition_key: dispositionKey,
      terminal_disposition_pending: false,
      terminal_disposition_final: true,
      terminal_disposition_reason: decision.disposition_reason,
      terminal_disposition_decision: decision,
      terminal_disposition_final_at: new Date().toISOString(),
    },
    updated_at: new Date().toISOString(),
  }).eq("id", sessionId);
}

export async function disposeTerminalTripPayment(
  supabase: SupabaseClient,
  args: {
    tripId: string;
    reason: TerminalDispositionReason;
    /** @deprecated Prefer canonical resolver; only used when forceFeePenceOverride is true. */
    feePence?: number | null;
    force?: boolean;
    forceFeePenceOverride?: boolean;
  },
): Promise<TerminalDispositionResult> {
  const { data: trip, error: tripErr } = await supabase
    .from("trips")
    .select(
      // Provider-neutral / Revolut identifiers only — never select removed Stripe PI columns
      // (legacy PI select caused PostgREST 400 → false trip_not_found).
      "id, status, started_at, arrived_at, free_wait_expires_at, cancelled_at, cancelled_by, scheduled_at, cancellation_grace_expires_at, driver_id, confirmed_driver_id, service_area_id, vehicle_type_id, payment_provider, provider_order_id, payment_session_id, authorised_amount_pence, cancellation_fee_pence, no_show_charge_pence, payment_status, arrival_cancellation_applied",
    )
    .eq("id", args.tripId)
    .maybeSingle();

  if (tripErr || !trip) {
    return {
      outcome: "SKIPPED_SAFETY_CHECK",
      trip_id: args.tripId,
      disposition_key: `terminal-void:${args.tripId}:${args.reason}`,
      message: tripErr ? `trip_lookup_failed:${tripErr.message}` : "trip_not_found",
    };
  }

  const provider = resolveTripPaymentProvider(trip);
  const orderId = tripProviderOrderId(trip);

  const { data: sessionFallback } = await supabase
    .from("payment_sessions")
    .select("id, provider_state, authorised_amount_pence, captured_amount_pence, released_amount_pence, metadata")
    .eq("trip_id", args.tripId)
    .eq("purpose", "RIDE_BOOKING")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const sessionByOrder = orderId
    ? (await supabase
      .from("payment_sessions")
      .select("id, provider_state, authorised_amount_pence, captured_amount_pence, released_amount_pence, metadata")
      .eq("trip_id", args.tripId)
      .eq("provider_order_id", orderId)
      .eq("purpose", "RIDE_BOOKING")
      .maybeSingle()).data
    : null;
  const paymentSession = sessionByOrder ?? sessionFallback;

  const { config, feePolicyId } = await loadFarePricingFeeConfig(
    supabase,
    trip.service_area_id as string | null,
    trip.vehicle_type_id as string | null,
  );

  const authPenceLocal = Number(
    paymentSession?.authorised_amount_pence ?? trip.authorised_amount_pence ?? 0,
  );
  const priorCaptured = Number(paymentSession?.captured_amount_pence ?? 0);

  let decision = resolveTerminalPaymentDecision({
    evidence: {
      trip_id: args.tripId,
      trip_status: trip.status as string | null,
      started_at: trip.started_at as string | null,
      arrived_at: trip.arrived_at as string | null,
      free_wait_expires_at: trip.free_wait_expires_at as string | null,
      cancelled_at: trip.cancelled_at as string | null,
      cancelled_by: trip.cancelled_by as string | null,
      scheduled_at: trip.scheduled_at as string | null,
      cancellation_grace_expires_at: trip.cancellation_grace_expires_at as string | null,
      driver_id: trip.driver_id as string | null,
      confirmed_driver_id: trip.confirmed_driver_id as string | null,
      no_show_recorded: normalizeStatus(trip.status as string) === "no_show",
      authorised_amount_pence: authPenceLocal,
      previously_captured_amount_pence: priorCaptured,
      payment_session_id: (paymentSession?.id as string | null) ?? null,
      provider: provider ?? "unknown",
      decision_at: new Date().toISOString(),
    },
    config,
    feePolicyId,
  });

  if (args.forceFeePenceOverride && args.feePence != null) {
    const fee = Math.max(0, Math.round(Number(args.feePence)));
    const remaining = Math.max(0, authPenceLocal - priorCaptured);
    const capture = fee > 0 ? Math.min(fee, remaining) : 0;
    decision = {
      ...decision,
      fee_amount_pence: capture,
      capture_required_pence: capture,
      release_required_pence: Math.max(0, remaining - capture),
      fee_type: capture > 0
        ? (decision.fee_type === "none" ? "cancellation" : decision.fee_type)
        : "none",
      provider_action: capture > 0
        ? "partial_capture_fee"
        : (decision.provider_action === "skip" ? "skip" : "void_full"),
      decision_evidence: { ...decision.decision_evidence, force_fee_override: true },
    };
  }

  const dispositionKey = decision.idempotency_key;
  const priorMeta = (paymentSession?.metadata && typeof paymentSession.metadata === "object")
    ? paymentSession.metadata as Record<string, unknown>
    : {};

  if (
    priorMeta.terminal_disposition_key === dispositionKey &&
    priorMeta.terminal_disposition_final === true
  ) {
    return {
      outcome: decision.capture_required_pence > 0
        ? "FEE_CAPTURED_AND_REMAINDER_RELEASED"
        : "ALREADY_RELEASED_RECONCILED",
      trip_id: args.tripId,
      disposition_key: dispositionKey,
      decision,
      message: "idempotent_replay",
      provider_order_id_mask: maskOrderId(orderId),
      authorised_pence: authPenceLocal,
      captured_fee_pence: decision.capture_required_pence,
      released_pence: decision.release_required_pence,
    };
  }

  if (decision.disposition_reason === "SKIP_COMPLETED") {
    return {
      outcome: "SKIPPED_COMPLETED",
      trip_id: args.tripId,
      disposition_key: dispositionKey,
      decision,
      message: decision.terminal_reason,
      provider_order_id_mask: maskOrderId(orderId),
    };
  }
  if (decision.disposition_reason === "SKIP_ACTIVE_OR_REMATCH") {
    return {
      outcome: "SKIPPED_REMATCH_OR_ACTIVE",
      trip_id: args.tripId,
      disposition_key: dispositionKey,
      decision,
      message: decision.terminal_reason,
      provider_order_id_mask: maskOrderId(orderId),
    };
  }
  if (decision.disposition_reason === "SKIP_STARTED_MISSING_INTERRUPTED_POLICY") {
    return {
      outcome: "SKIPPED_STARTED_MISSING_INTERRUPTED_POLICY",
      trip_id: args.tripId,
      disposition_key: dispositionKey,
      decision,
      message: decision.terminal_reason,
      provider_order_id_mask: maskOrderId(orderId),
    };
  }
  if (decision.provider_action === "skip") {
    return {
      outcome: "SKIPPED_SAFETY_CHECK",
      trip_id: args.tripId,
      disposition_key: dispositionKey,
      decision,
      message: decision.terminal_reason,
      provider_order_id_mask: maskOrderId(orderId),
    };
  }

  const feePence = decision.capture_required_pence;
  const classified = classifyTerminalHoldDisposition({
    tripStatus: trip.status,
    startedAt: trip.started_at,
    feePence,
    hasProviderOrder: !!orderId,
    provider,
  });

  if (classified.action === "skip") {
    return {
      outcome: classified.outcome ?? "SKIPPED_SAFETY_CHECK",
      trip_id: args.tripId,
      disposition_key: dispositionKey,
      decision,
      message: classified.reason,
      provider_order_id_mask: maskOrderId(orderId),
    };
  }

  if (provider !== "revolut" || !orderId) {
    return {
      outcome: provider !== "revolut" ? "SKIPPED_NOT_REVOLUT" : "SKIPPED_NO_ORDER",
      trip_id: args.tripId,
      disposition_key: dispositionKey,
      decision,
      provider_order_id_mask: maskOrderId(orderId),
    };
  }

  const releaseTrigger = mapReasonToReleaseTrigger(args.reason);
  const guard = await assertHoldReleaseAllowed(supabase, {
    tripId: args.tripId,
    reason: releaseTrigger,
  });
  if (!guard.allowed) {
    return {
      outcome: "HOLD_PROTECTED",
      trip_id: args.tripId,
      disposition_key: dispositionKey,
      decision,
      message: guard.message,
      provider_order_id_mask: maskOrderId(orderId),
    };
  }

  if (guard.parent_session_id || paymentSession?.id) {
    await stampReleaseTrigger(
      supabase,
      (guard.parent_session_id ?? paymentSession!.id) as string,
      releaseTrigger,
      {
        disposition_key: dispositionKey,
        terminal_reason: args.reason,
        fee_disposition_reason: decision.disposition_reason,
      },
    );
  }

  if (paymentSession?.id) {
    await supabase.from("payment_sessions").update({
      metadata: {
        ...priorMeta,
        terminal_disposition_key: dispositionKey,
        terminal_disposition_pending: true,
        terminal_disposition_reason: decision.disposition_reason,
        terminal_disposition_decision: decision,
        terminal_disposition_pending_at: new Date().toISOString(),
      },
      updated_at: new Date().toISOString(),
    }).eq("id", paymentSession.id);
  }

  const tripFeePatch: Record<string, unknown> = {
    cancellation_fee_pence: decision.disposition_reason === "CUSTOMER_NO_SHOW"
      ? 0
      : decision.fee_amount_pence,
    updated_at: new Date().toISOString(),
  };
  if (decision.disposition_reason === "CUSTOMER_NO_SHOW") {
    tripFeePatch.no_show_charge_pence = decision.fee_amount_pence;
    tripFeePatch.cancellation_fee_pence = decision.fee_amount_pence;
  }
  if (decision.disposition_reason === "ARRIVAL_CANCELLATION_FEE") {
    tripFeePatch.arrival_cancellation_applied = true;
    tripFeePatch.arrival_cancellation_fee = decision.fee_amount_pence / 100;
    tripFeePatch.arrival_cancellation_applied_at = new Date().toISOString();
    tripFeePatch.arrival_cancellation_reason = "ARRIVAL_CANCELLATION_FEE";
    tripFeePatch.cancellation_fee_pence = decision.fee_amount_pence;
  }
  if (decision.disposition_reason === "LATE_PASSENGER_CANCELLATION") {
    tripFeePatch.late_cancel_fee_pence = decision.fee_amount_pence;
    tripFeePatch.cancellation_fee_pence = decision.fee_amount_pence;
  }
  await supabase.from("trips").update(tripFeePatch).eq("id", args.tripId);

  const { secretKey, environment } = getRevolutMerchantConfig();

  let orderBefore;
  try {
    orderBefore = await retrieveRevolutOrder(environment, secretKey, orderId);
  } catch (e) {
    return {
      outcome: "PROVIDER_FAILED",
      trip_id: args.tripId,
      disposition_key: dispositionKey,
      decision,
      message: `retrieve_failed:${(e as Error).message}`,
      provider_order_id_mask: maskOrderId(orderId),
    };
  }

  const stateBefore = String(orderBefore.state ?? "").toUpperCase();
  const authPence = Number(
    orderBefore.amount ?? trip.authorised_amount_pence ?? paymentSession?.authorised_amount_pence ?? 0,
  );
  const completedAmt = Number(orderBefore.completed_amount ?? 0);

  if (RELEASED_PROVIDER.has(stateBefore) && completedAmt === 0) {
    const ok = paymentSession?.id
      ? await reconcileSessionCancelled(supabase, {
        sessionId: paymentSession.id as string,
        tripId: args.tripId,
        orderId,
        authPence,
        providerState: stateBefore === "CANCELED" ? "CANCELLED" : stateBefore,
        dispositionKey,
      })
      : true;
    if (ok && paymentSession?.id) {
      await markDispositionFinal(supabase, paymentSession.id as string, priorMeta, dispositionKey, decision);
    }
    return {
      outcome: ok ? "ALREADY_RELEASED_RECONCILED" : "LOCAL_RECONCILIATION_FAILED_AFTER_PROVIDER_SUCCESS",
      trip_id: args.tripId,
      disposition_key: dispositionKey,
      decision,
      provider_state: stateBefore,
      authorised_pence: authPence,
      released_pence: authPence,
      provider_order_id_mask: maskOrderId(orderId),
    };
  }

  if (stateBefore === "COMPLETED" && completedAmt > 0) {
    const ok = paymentSession?.id
      ? await reconcileSessionCancelled(supabase, {
        sessionId: paymentSession.id as string,
        tripId: args.tripId,
        orderId,
        authPence,
        providerState: "COMPLETED",
        dispositionKey,
        capturedFeePence: completedAmt,
      })
      : true;
    if (ok && paymentSession?.id) {
      await markDispositionFinal(supabase, paymentSession.id as string, priorMeta, dispositionKey, decision);
    }
    return {
      outcome: ok ? "FEE_CAPTURED_AND_REMAINDER_RELEASED" : "LOCAL_RECONCILIATION_FAILED_AFTER_PROVIDER_SUCCESS",
      trip_id: args.tripId,
      disposition_key: dispositionKey,
      decision,
      provider_state: stateBefore,
      authorised_pence: authPence,
      captured_fee_pence: completedAmt,
      released_pence: Math.max(0, authPence - completedAmt),
      provider_order_id_mask: maskOrderId(orderId),
      message: "provider_already_completed_reconciled",
    };
  }

  if (!OPEN_PROVIDER.has(stateBefore)) {
    return {
      outcome: "SKIPPED_SAFETY_CHECK",
      trip_id: args.tripId,
      disposition_key: dispositionKey,
      decision,
      message: `provider_state=${stateBefore}`,
      provider_state: stateBefore,
      provider_order_id_mask: maskOrderId(orderId),
    };
  }

  if (completedAmt > 0 && feePence === 0) {
    return {
      outcome: "SKIPPED_SAFETY_CHECK",
      trip_id: args.tripId,
      disposition_key: dispositionKey,
      decision,
      message: `already_captured=${completedAmt}`,
      provider_order_id_mask: maskOrderId(orderId),
    };
  }

  try {
    if (
      decision.provider_action === "partial_capture_fee" ||
      classified.action === "partial_capture_fee"
    ) {
      const fee = Math.min(feePence, authPence);
      if (fee > 0) {
        await captureRevolutOrder(environment, secretKey, orderId, fee);
        const afterCap = await retrieveRevolutOrder(environment, secretKey, orderId);
        const stateAfterCap = String(afterCap.state ?? "").toUpperCase();
        if (stateAfterCap !== "COMPLETED" && !RELEASED_PROVIDER.has(stateAfterCap)) {
          return {
            outcome: "PROVIDER_PENDING_RECONCILIATION",
            trip_id: args.tripId,
            disposition_key: dispositionKey,
            decision,
            provider_state: stateAfterCap,
            message: "partial_capture_unconfirmed",
            provider_order_id_mask: maskOrderId(orderId),
          };
        }
        const ok = paymentSession?.id
          ? await reconcileSessionCancelled(supabase, {
            sessionId: paymentSession.id as string,
            tripId: args.tripId,
            orderId,
            authPence,
            providerState: stateAfterCap === "COMPLETED" ? "COMPLETED" : stateAfterCap,
            dispositionKey,
            capturedFeePence: fee,
          })
          : true;
        await supabase.from("trips").update({
          payment_status: "captured",
          capture_amount_pence: fee,
          updated_at: new Date().toISOString(),
        }).eq("id", args.tripId);
        if (ok && paymentSession?.id) {
          await markDispositionFinal(supabase, paymentSession.id as string, priorMeta, dispositionKey, decision);
        }
        return {
          outcome: ok ? "FEE_CAPTURED_AND_REMAINDER_RELEASED" : "LOCAL_RECONCILIATION_FAILED_AFTER_PROVIDER_SUCCESS",
          trip_id: args.tripId,
          disposition_key: dispositionKey,
          decision,
          provider_state: stateAfterCap,
          authorised_pence: authPence,
          captured_fee_pence: fee,
          released_pence: Math.max(0, authPence - fee),
          provider_order_id_mask: maskOrderId(orderId),
        };
      }
    }

    // Prefer cancel response state — immediate retrieve can lag behind Revolut's
    // cancel acceptance and falsely report AUTHORISED (post_cancel_not_released).
    const cancelResult = await cancelRevolutOrder(environment, secretKey, orderId);
    let after = await retrieveRevolutOrder(environment, secretKey, orderId);
    let stateAfter = String(after.state ?? "").toUpperCase();
    const cancelState = String(cancelResult.state ?? "").toUpperCase();
    if (!RELEASED_PROVIDER.has(stateAfter) && RELEASED_PROVIDER.has(cancelState)) {
      stateAfter = cancelState;
      after = {
        ...after,
        state: cancelResult.state,
        completed_amount: cancelResult.completed_amount ?? after.completed_amount,
      };
    }
    if (!RELEASED_PROVIDER.has(stateAfter)) {
      for (let attempt = 0; attempt < 3 && !RELEASED_PROVIDER.has(stateAfter); attempt++) {
        await new Promise((r) => setTimeout(r, 400));
        after = await retrieveRevolutOrder(environment, secretKey, orderId);
        stateAfter = String(after.state ?? "").toUpperCase();
      }
    }
    if (!RELEASED_PROVIDER.has(stateAfter)) {
      return {
        outcome: "PROVIDER_PENDING_RECONCILIATION",
        trip_id: args.tripId,
        disposition_key: dispositionKey,
        decision,
        provider_state: stateAfter,
        message: "post_cancel_not_released",
        provider_order_id_mask: maskOrderId(orderId),
      };
    }
    if (Number(after.completed_amount ?? 0) !== 0) {
      return {
        outcome: "SKIPPED_SAFETY_CHECK",
        trip_id: args.tripId,
        disposition_key: dispositionKey,
        decision,
        message: "post_cancel_nonzero_capture",
        provider_order_id_mask: maskOrderId(orderId),
      };
    }

    const ok = paymentSession?.id
      ? await reconcileSessionCancelled(supabase, {
        sessionId: paymentSession.id as string,
        tripId: args.tripId,
        orderId,
        authPence,
        providerState: "CANCELLED",
        dispositionKey,
      })
      : true;
    if (ok && paymentSession?.id) {
      await markDispositionFinal(supabase, paymentSession.id as string, priorMeta, dispositionKey, decision);
    }
    return {
      outcome: ok ? "RELEASED_AND_RECONCILED" : "LOCAL_RECONCILIATION_FAILED_AFTER_PROVIDER_SUCCESS",
      trip_id: args.tripId,
      disposition_key: dispositionKey,
      decision,
      provider_state: stateAfter,
      authorised_pence: authPence,
      released_pence: authPence,
      captured_fee_pence: 0,
      provider_order_id_mask: maskOrderId(orderId),
    };
  } catch (e) {
    try {
      const check = await retrieveRevolutOrder(environment, secretKey, orderId);
      const st = String(check.state ?? "").toUpperCase();
      if (RELEASED_PROVIDER.has(st) && Number(check.completed_amount ?? 0) === 0) {
        const ok = paymentSession?.id
          ? await reconcileSessionCancelled(supabase, {
            sessionId: paymentSession.id as string,
            tripId: args.tripId,
            orderId,
            authPence,
            providerState: "CANCELLED",
            dispositionKey,
          })
          : true;
        if (ok && paymentSession?.id) {
          await markDispositionFinal(supabase, paymentSession.id as string, priorMeta, dispositionKey, decision);
        }
        return {
          outcome: ok ? "ALREADY_RELEASED_RECONCILED" : "LOCAL_RECONCILIATION_FAILED_AFTER_PROVIDER_SUCCESS",
          trip_id: args.tripId,
          disposition_key: dispositionKey,
          decision,
          provider_state: st,
          authorised_pence: authPence,
          released_pence: authPence,
          provider_order_id_mask: maskOrderId(orderId),
          message: `recovered_after_error:${(e as Error).message}`,
        };
      }
      const completedAfter = Number(check.completed_amount ?? 0);
      if (st === "COMPLETED" && completedAfter > 0) {
        const ok = paymentSession?.id
          ? await reconcileSessionCancelled(supabase, {
            sessionId: paymentSession.id as string,
            tripId: args.tripId,
            orderId,
            authPence,
            providerState: "COMPLETED",
            dispositionKey,
            capturedFeePence: completedAfter,
          })
          : true;
        if (ok && paymentSession?.id) {
          await markDispositionFinal(supabase, paymentSession.id as string, priorMeta, dispositionKey, decision);
        }
        return {
          outcome: ok ? "FEE_CAPTURED_AND_REMAINDER_RELEASED" : "LOCAL_RECONCILIATION_FAILED_AFTER_PROVIDER_SUCCESS",
          trip_id: args.tripId,
          disposition_key: dispositionKey,
          decision,
          provider_state: st,
          authorised_pence: authPence,
          captured_fee_pence: completedAfter,
          released_pence: Math.max(0, authPence - completedAfter),
          provider_order_id_mask: maskOrderId(orderId),
          message: `recovered_capture_after_error:${(e as Error).message}`,
        };
      }
      return {
        outcome: "PROVIDER_PENDING_RECONCILIATION",
        trip_id: args.tripId,
        disposition_key: dispositionKey,
        decision,
        provider_state: st,
        message: `ambiguous_after_error:${(e as Error).message}`,
        provider_order_id_mask: maskOrderId(orderId),
      };
    } catch {
      return {
        outcome: "PROVIDER_FAILED",
        trip_id: args.tripId,
        disposition_key: dispositionKey,
        decision,
        message: (e as Error).message,
        provider_order_id_mask: maskOrderId(orderId),
      };
    }
  }
}
