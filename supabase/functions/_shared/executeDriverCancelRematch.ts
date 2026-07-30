/**
 * Driver cancel before start → rematch (customer trip survives).
 * Critical mutation is atomic via driver_cancel_before_start_rematch RPC.
 * auto-dispatch is invoked after commit; failures leave trip in searching_new_driver.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  customerSearchWindowMs,
  DISPATCH_SETTINGS_SCHEMA_DEFAULTS,
} from "./dispatch-settings.ts";
import { rebroadcastTripViaAutoDispatch } from "./dispatchOrchestrator.ts";
import { handleQueuedTripAfterCurrentTripFailure } from "./stackedRideLifecycle.ts";
import {
  buildSearchCycleId,
  isDriverAssignedToTrip,
  isPrePickupDriverRematchEligibleDbStatus,
  logTripAssignedDriverFieldResolved,
  PRE_PICKUP_DRIVER_REMATCH_DB_STATUSES,
  TRIP_CANCEL_REMATCH_SELECT,
} from "./driverCancelRematch.ts";
import { resolveCancellationOutcome } from "./cancellationOutcome.ts";

export type DriverCancelRematchResult =
  | {
      ok: true;
      action: "driver_cancel_rematch";
      detail: Record<string, unknown>;
    }
  | { ok: false; code: string; message: string; status: number };

export type DriverCancelRematchRpcResult = {
  ok?: boolean;
  outcome?: string;
  trip_id?: string;
  previous_status?: string;
  status?: string;
  dispatch_status?: string;
  driver_cleared?: boolean;
  driver_excluded?: boolean;
  payment_action?: string;
  idempotent_replay?: boolean;
  current_broadcast_round?: number | null;
  searching_expires_at?: string | null;
  audit_event_id?: string | null;
  dispatch_outbox_key?: string | null;
  finance_unchanged?: boolean;
  customer_active_trip_preserved?: boolean;
  error?: string;
  message?: string;
};

function mapRpcErrorStatus(code: string | undefined): number {
  switch ((code ?? "").toUpperCase()) {
    case "NOT_FOUND":
      return 404;
    case "FORBIDDEN":
    case "UNAUTHORIZED":
      return 403;
    case "NO_SHOW_NOT_ALLOWED":
    case "VALIDATION":
    case "INVALID_STATE":
    case "USE_TERMINAL_CANCEL":
      return 400;
    case "CONFLICT":
      return 409;
    default:
      return 500;
  }
}

async function markDispatchOutbox(
  supabase: SupabaseClient,
  outboxKey: string | null | undefined,
  patch: { status: "done" | "failed" | "processing"; last_error?: string | null },
  ensure?: { tripId: string; triggerReason?: string },
): Promise<void> {
  if (!outboxKey) return;
  const payload: Record<string, unknown> = {
    status: patch.status,
    processed_at: patch.status === "done" ? new Date().toISOString() : null,
  };
  if (patch.status === "failed") {
    payload.last_error = patch.last_error ?? "auto-dispatch invoke failed";
  }
  if (patch.status === "processing" || patch.status === "failed") {
    // attempts incremented via RPC-less read-modify would race; best-effort bump
    const { data } = await supabase
      .from("dispatch_intent_outbox")
      .select("attempts")
      .eq("idempotency_key", outboxKey)
      .maybeSingle();
    const attempts =
      typeof (data as { attempts?: number } | null)?.attempts === "number"
        ? ((data as { attempts: number }).attempts + 1)
        : 1;
    payload.attempts = attempts;

    // Soft replay can hit a missing outbox row; create a retryable record first.
    if (!data && ensure?.tripId) {
      await supabase.from("dispatch_intent_outbox").upsert(
        {
          trip_id: ensure.tripId,
          intent: "auto_dispatch_rebroadcast",
          trigger_reason: ensure.triggerReason ?? "driver_cancel_before_pickup",
          idempotency_key: outboxKey,
          status: "pending",
          attempts: 0,
          payload: { force_rebroadcast: true, edge_ensured: true },
        },
        { onConflict: "idempotency_key" },
      );
    }
  }
  await supabase
    .from("dispatch_intent_outbox")
    .update(payload)
    .eq("idempotency_key", outboxKey);
}

/**
 * Apply pre-start driver cancel → searching_new_driver rematch.
 * Atomic DB mutation via RPC; rebroadcast via already-deployed auto-dispatch.
 */
export async function executeDriverCancelBeforePickupRematch(
  supabase: SupabaseClient,
  input: {
    tripId: string;
    driverId: string;
    /** Optional preloaded trip row (must include rematch select fields). */
    trip?: Record<string, unknown> | null;
    source?: string;
    reason?: string | null;
    idempotencyKey?: string | null;
    requestMetadata?: Record<string, unknown>;
  },
): Promise<DriverCancelRematchResult> {
  const { tripId, driverId } = input;
  const source = input.source ?? "executeDriverCancelBeforePickupRematch";

  logTripAssignedDriverFieldResolved(source);

  let trip = input.trip ?? null;
  if (!trip) {
    const { data, error } = await supabase
      .from("trips")
      .select(TRIP_CANCEL_REMATCH_SELECT)
      .eq("id", tripId)
      .maybeSingle();
    if (error || !data) {
      return {
        ok: false,
        code: "NOT_FOUND",
        message: error?.message ?? "Trip not found",
        status: 404,
      };
    }
    trip = data as Record<string, unknown>;
  }

  const rawStatus = String(trip.status ?? "").trim().toLowerCase();
  const outcome = resolveCancellationOutcome({
    actor: "driver",
    status: rawStatus,
    startedAt: typeof trip.started_at === "string" ? trip.started_at : null,
    arrivedAt: typeof trip.arrived_at === "string" ? trip.arrived_at : null,
    dispatchStatus: typeof trip.dispatch_status === "string" ? trip.dispatch_status : null,
    isNoShow: false,
    driverId,
    confirmedDriverId:
      typeof trip.confirmed_driver_id === "string" ? trip.confirmed_driver_id : null,
  });

  if (outcome.kind === "reject") {
    return {
      ok: false,
      code: outcome.error_code ?? "INVALID_STATE",
      message: outcome.reason ?? `Cannot cancel as driver in status: ${rawStatus}`,
      status: 400,
    };
  }

  if (outcome.kind !== "rematch") {
    return {
      ok: false,
      code: "USE_TERMINAL_CANCEL",
      message: "Pre-pickup rematch not applicable — use terminal cancel path",
      status: 400,
    };
  }

  if (!isPrePickupDriverRematchEligibleDbStatus(rawStatus)) {
    return {
      ok: false,
      code: "INVALID_STATE",
      message: `Cannot cancel as driver in status: ${rawStatus}`,
      status: 400,
    };
  }

  if (!trip.confirmed_driver_id) {
    return {
      ok: false,
      code: "INVALID_STATE",
      message: "Trip has no assigned driver — cannot rematch",
      status: 409,
    };
  }

  if (!isDriverAssignedToTrip(
    { confirmed_driver_id: trip.confirmed_driver_id as string | null },
    driverId,
  )) {
    return {
      ok: false,
      code: "FORBIDDEN",
      message: "Not assigned to this trip",
      status: 403,
    };
  }

  const incomingMeta = input.requestMetadata ?? {};
  if (
    incomingMeta.is_no_show === true ||
    ["no_show", "passenger_no_show", "noshow"].includes(
      String(incomingMeta.action_type ?? "").toLowerCase(),
    ) ||
    ["no_show", "passenger_no_show"].includes(
      String(incomingMeta.cancellation_type ?? "").toLowerCase(),
    )
  ) {
    return {
      ok: false,
      code: "NO_SHOW_NOT_ALLOWED",
      message: "No-show must use cancel-trip with is_no_show=true; rematch RPC rejects no-show",
      status: 400,
    };
  }

  const broadcastRound =
    typeof trip.current_broadcast_round === "number" &&
      Number.isFinite(trip.current_broadcast_round)
      ? Math.max(0, Math.floor(trip.current_broadcast_round))
      : 0;

  // Include broadcast round so a later reassignment cancel is not poisoned by a prior rematch key.
  const idempotencyKey =
    input.idempotencyKey ??
    `driver_cancel_before_pickup:${tripId}:${driverId}:r${broadcastRound}`;

  const requestMetadata: Record<string, unknown> = {
    ...incomingMeta,
    actor_mode: "service_role",
    actor: "edge",
    source,
    is_no_show: false,
  };

  const { data: rpcData, error: rpcError } = await supabase.rpc(
    "driver_cancel_before_start_rematch",
    {
      p_trip_id: tripId,
      p_driver_id: driverId,
      p_reason: input.reason ?? "driver_cancelled",
      p_idempotency_key: idempotencyKey,
      p_request_metadata: requestMetadata,
    },
  );

  if (rpcError) {
    const msg = rpcError.message ?? "Rematch RPC failed";
    const conflict = /CONFLICT|assignment changed/i.test(msg);
    return {
      ok: false,
      code: conflict ? "CONFLICT" : "INTERNAL_ERROR",
      message: msg,
      status: conflict ? 409 : 500,
    };
  }

  const rpc = (rpcData ?? {}) as DriverCancelRematchRpcResult;
  if (!rpc.ok) {
    return {
      ok: false,
      code: String(rpc.error ?? "INVALID_STATE"),
      message: String(rpc.message ?? "Rematch rejected"),
      status: mapRpcErrorStatus(rpc.error),
    };
  }

  const outboxKey =
    typeof rpc.dispatch_outbox_key === "string" ? rpc.dispatch_outbox_key : idempotencyKey;

  const isIdempotentReplay = rpc.idempotent_replay === true;
  let dispatchResult: { ok: boolean; error?: string } = { ok: true };
  let dispatchSkipped = false;

  if (isIdempotentReplay) {
    // Soft/hard replay: retry when outbox is missing, pending, or failed.
    // Never roll back rematch; never cancel the customer trip.
    const { data: outboxRow } = await supabase
      .from("dispatch_intent_outbox")
      .select("status")
      .eq("idempotency_key", outboxKey)
      .maybeSingle();
    const outboxStatus = (outboxRow as { status?: string } | null)?.status ?? null;
    const shouldRetryDispatch =
      outboxStatus == null ||
      outboxStatus === "pending" ||
      outboxStatus === "failed";

    if (shouldRetryDispatch) {
      await markDispatchOutbox(supabase, outboxKey, { status: "processing" }, {
        tripId,
        triggerReason: "driver_cancel_before_pickup",
      });
      dispatchResult = await rebroadcastTripViaAutoDispatch(
        supabase,
        tripId,
        "driver_cancel_before_pickup",
      );
      if (!dispatchResult.ok) {
        console.error(`[${source}] auto-dispatch retry:`, dispatchResult.error);
        await markDispatchOutbox(supabase, outboxKey, {
          status: "failed",
          last_error: dispatchResult.error ?? "auto-dispatch invoke failed",
        }, { tripId });
      } else {
        await markDispatchOutbox(supabase, outboxKey, { status: "done" });
      }
    } else {
      dispatchSkipped = true;
    }
  } else {
    await markDispatchOutbox(supabase, outboxKey, { status: "processing" }, {
      tripId,
      triggerReason: "driver_cancel_before_pickup",
    });

    dispatchResult = await rebroadcastTripViaAutoDispatch(
      supabase,
      tripId,
      "driver_cancel_before_pickup",
    );

    if (!dispatchResult.ok) {
      console.error(`[${source}] auto-dispatch:`, dispatchResult.error);
      await markDispatchOutbox(supabase, outboxKey, {
        status: "failed",
        last_error: dispatchResult.error ?? "auto-dispatch invoke failed",
      }, { tripId });
      // Keep trip in searching_new_driver — retryable via outbox / orchestrator.
    } else {
      await markDispatchOutbox(supabase, outboxKey, { status: "done" });
    }
  }

  if (typeof trip.stacked_trip_id === "string" && trip.stacked_trip_id) {
    await handleQueuedTripAfterCurrentTripFailure(supabase, {
      currentTripId: tripId,
      driverId,
      failureReason: "driver_cancel_before_pickup",
    });
  }

  // Search window metadata is informational; RPC already set searching_expires_at.
  const searchWindowMs = customerSearchWindowMs(DISPATCH_SETTINGS_SCHEMA_DEFAULTS);
  const searchingExpiresAt =
    typeof rpc.searching_expires_at === "string"
      ? rpc.searching_expires_at
      : null;
  const rematchBroadcastRound =
    typeof rpc.current_broadcast_round === "number"
      ? rpc.current_broadcast_round
      : null;
  const searchCycleId = buildSearchCycleId(
    tripId,
    rematchBroadcastRound,
    searchingExpiresAt,
  );

  return {
    ok: true,
    action: "driver_cancel_rematch",
    detail: {
      tripId,
      status: rpc.status ?? "searching_new_driver",
      dispatch_status: rpc.dispatch_status ?? "broadcasting",
      searching_expires_at: searchingExpiresAt,
      search_window_ms: searchWindowMs,
      search_cycle_id: searchCycleId,
      current_broadcast_round: rematchBroadcastRound,
      outcome: rpc.outcome ?? "rematch",
      payment_action: rpc.payment_action ?? "unchanged",
      driver_cleared: rpc.driver_cleared ?? true,
      driver_excluded: rpc.driver_excluded ?? true,
      idempotent_replay: isIdempotentReplay,
      finance_unchanged: rpc.finance_unchanged ?? true,
      customer_active_trip_preserved: rpc.customer_active_trip_preserved ?? true,
      audit_event_id: rpc.audit_event_id ?? null,
      dispatch_outbox_key: outboxKey,
      dispatch_invoked: dispatchSkipped ? false : dispatchResult.ok,
      dispatch_skipped_idempotent_replay: dispatchSkipped,
      dispatch_error: dispatchSkipped
        ? null
        : (dispatchResult.ok ? null : (dispatchResult.error ?? "invoke_failed")),
      allowed_pre_pickup_statuses: PRE_PICKUP_DRIVER_REMATCH_DB_STATUSES,
      lifecycle_outcome: outcome.kind,
      atomic_rpc: "driver_cancel_before_start_rematch",
    },
  };
}
