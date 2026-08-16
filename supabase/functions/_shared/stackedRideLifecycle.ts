/**
 * Stacked ride lifecycle — orphan prevention when Trip A fails while Trip B is queued.
 * Does not touch fare/wallet logic. Safe to run while stacked rides are disabled.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { rebroadcastTripViaAutoDispatch } from "./dispatchOrchestrator.ts";

export const STACKED_RIDE_ORPHAN_PREVENTED = "STACKED_RIDE_ORPHAN_PREVENTED";
export const STACKED_RIDE_CANCELLED_DUE_TO_CURRENT_TRIP_FAILURE =
  "STACKED_RIDE_CANCELLED_DUE_TO_CURRENT_TRIP_FAILURE";
export const STACKED_RIDE_PROMOTED = "STACKED_RIDE_PROMOTED";
export const STACKED_RIDE_REDISPATCHED = "STACKED_RIDE_REDISPATCHED";
export const STACKED_RIDE_DRIVER_QUEUED_CANCEL = "STACKED_RIDE_DRIVER_QUEUED_CANCEL";
export const STACKED_RIDE_LINK_CLEARED = "STACKED_RIDE_LINK_CLEARED";
export const STACKED_RIDE_PROMOTION_SKIPPED_CURRENT_TRIP_NOT_COMPLETED =
  "STACKED_RIDE_PROMOTION_SKIPPED_CURRENT_TRIP_NOT_COMPLETED";

export type StackedCurrentTripFailureReason =
  | "pickup_no_show"
  | "customer_cancel"
  | "driver_cancel_before_pickup"
  | "driver_cancel_terminal"
  | "driver_cancel_queued"
  | "payment_failure"
  | "driver_offline";

type LifecycleResult = {
  handled: boolean;
  queued_trip_id?: string;
  action?: "promoted" | "redispatched" | "cancelled" | "unlinked" | "skipped";
  detail?: string;
};

function logLifecycle(
  token: string,
  payload: Record<string, unknown>,
): void {
  console.log(token, payload);
}

/** Clear stacked_trip_id links and emit observability token. */
async function clearStackedTripLinks(
  supabase: SupabaseClient,
  params: {
    parentTripId?: string;
    queuedTripId?: string;
    reason: string;
    failureReason?: StackedCurrentTripFailureReason;
  },
): Promise<void> {
  const now = new Date().toISOString();

  if (params.queuedTripId) {
    await supabase
      .from("trips")
      .update({ stacked_trip_id: null, updated_at: now })
      .eq("stacked_trip_id", params.queuedTripId);
  }

  if (params.parentTripId) {
    await supabase
      .from("trips")
      .update({ stacked_trip_id: null, updated_at: now })
      .eq("id", params.parentTripId);
  }

  logLifecycle(STACKED_RIDE_LINK_CLEARED, {
    parent_trip_id: params.parentTripId ?? null,
    queued_trip_id: params.queuedTripId ?? null,
    reason: params.reason,
    failure_reason: params.failureReason ?? null,
  });
}

export function logStackedPromotionSkipped(
  payload: Record<string, unknown>,
): void {
  logLifecycle(STACKED_RIDE_PROMOTION_SKIPPED_CURRENT_TRIP_NOT_COMPLETED, payload);
}

/** Promote queued Trip B after Trip A ends without driver fault (no-show, customer cancel). */
async function promoteQueuedStackedTrip(
  supabase: SupabaseClient,
  driverId: string,
  currentTripId: string,
  queuedTripId: string,
  failureReason: StackedCurrentTripFailureReason,
): Promise<LifecycleResult> {
  const { data, error } = await supabase.rpc("promote_stacked_trip", {
    p_driver_id: driverId,
    p_completed_trip_id: currentTripId,
  });

  if (error) {
    logLifecycle(STACKED_RIDE_ORPHAN_PREVENTED, {
      current_trip_id: currentTripId,
      queued_trip_id: queuedTripId,
      driver_id: driverId,
      failure_reason: failureReason,
      promote_error: error.message,
      action_needed: "manual_review",
    });
    return { handled: false, queued_trip_id: queuedTripId, action: "skipped", detail: error.message };
  }

  const promoted = data?.promoted === true;
  if (promoted) {
    logLifecycle(STACKED_RIDE_PROMOTED, {
      current_trip_id: currentTripId,
      queued_trip_id: queuedTripId,
      driver_id: driverId,
      failure_reason: failureReason,
      rpc_result: data,
    });
    return { handled: true, queued_trip_id: queuedTripId, action: "promoted" };
  }

  logLifecycle(STACKED_RIDE_ORPHAN_PREVENTED, {
    current_trip_id: currentTripId,
    queued_trip_id: queuedTripId,
    driver_id: driverId,
    failure_reason: failureReason,
    rpc_result: data,
    action_needed: "redispatch_or_cancel",
  });
  return { handled: false, queued_trip_id: queuedTripId, action: "skipped", detail: data?.reason };
}

/** Re-dispatch queued Trip B when Trip A fails due to driver action. */
async function redispatchQueuedStackedTrip(
  supabase: SupabaseClient,
  currentTripId: string,
  queuedTripId: string,
  failureReason: StackedCurrentTripFailureReason,
): Promise<LifecycleResult> {
  const now = new Date().toISOString();

  await clearStackedTripLinks(supabase, {
    queuedTripId,
    parentTripId: currentTripId,
    reason: "redispatch_queued_trip",
    failureReason,
  });

  // SSOT: use 'stacked_rebroadcasting' so admin panel can distinguish a stacked trip
  // that was re-queued for dispatch (due to driver failure) from a brand-new searching trip.
  // Auto-dispatch accepts both 'searching' and 'stacked_rebroadcasting' as dispatchable states.
  const { error: resetErr } = await supabase
    .from("trips")
    .update({
      status: "searching",
      dispatch_status: "stacked_rebroadcasting",
      driver_id: null,
      confirmed_driver_id: null,
      cancelled_driver_ids: null,
      stack_position: null,
      updated_at: now,
    })
    .eq("id", queuedTripId)
    .eq("status", "queued");

  if (resetErr) {
    logLifecycle(STACKED_RIDE_ORPHAN_PREVENTED, {
      current_trip_id: currentTripId,
      queued_trip_id: queuedTripId,
      failure_reason: failureReason,
      reset_error: resetErr.message,
    });
    return cancelQueuedStackedTrip(supabase, currentTripId, queuedTripId, failureReason);
  }

  const dispatchResult = await rebroadcastTripViaAutoDispatch(
    supabase,
    queuedTripId,
    `stacked_redispatch_${failureReason}`,
  );

  logLifecycle(STACKED_RIDE_REDISPATCHED, {
    current_trip_id: currentTripId,
    queued_trip_id: queuedTripId,
    failure_reason: failureReason,
    dispatch_ok: dispatchResult.ok,
    dispatch_path: dispatchResult.path,
    dispatch_error: dispatchResult.error ?? null,
  });

  return {
    handled: true,
    queued_trip_id: queuedTripId,
    action: "redispatched",
    detail: dispatchResult.error,
  };
}

/** Cancel queued Trip B when promotion/redispatch is not viable. */
async function cancelQueuedStackedTrip(
  supabase: SupabaseClient,
  currentTripId: string,
  queuedTripId: string,
  failureReason: StackedCurrentTripFailureReason,
): Promise<LifecycleResult> {
  const now = new Date().toISOString();

  await clearStackedTripLinks(supabase, {
    queuedTripId,
    parentTripId: currentTripId,
    reason: "cancel_queued_trip",
    failureReason,
  });

  const { error } = await supabase
    .from("trips")
    .update({
      status: "cancelled",
      cancelled_at: now,
      cancelled_by: "system",
      cancel_reason: `stacked_current_trip_${failureReason}`,
      updated_at: now,
    })
    .eq("id", queuedTripId)
    .eq("status", "queued");

  if (error) {
    logLifecycle(STACKED_RIDE_ORPHAN_PREVENTED, {
      current_trip_id: currentTripId,
      queued_trip_id: queuedTripId,
      failure_reason: failureReason,
      cancel_error: error.message,
    });
    return { handled: false, queued_trip_id: queuedTripId, action: "skipped", detail: error.message };
  }

  logLifecycle(STACKED_RIDE_CANCELLED_DUE_TO_CURRENT_TRIP_FAILURE, {
    current_trip_id: currentTripId,
    queued_trip_id: queuedTripId,
    failure_reason: failureReason,
  });

  return { handled: true, queued_trip_id: queuedTripId, action: "cancelled" };
}

/**
 * Trip A failed — handle all queued stacked trips for this driver (Admin max 1–3).
 * Prefer stack_position order; fall back to trips.stacked_trip_id on Trip A.
 */
export async function handleQueuedTripAfterCurrentTripFailure(
  supabase: SupabaseClient,
  params: {
    currentTripId: string;
    driverId: string | null;
    failureReason: StackedCurrentTripFailureReason;
  },
): Promise<LifecycleResult> {
  const { currentTripId, driverId, failureReason } = params;

  const queuedIds: string[] = [];

  if (driverId) {
    const { data: queuedRows } = await supabase
      .from("trips")
      .select("id, stack_position, created_at")
      .eq("status", "queued")
      .or(`driver_id.eq.${driverId},confirmed_driver_id.eq.${driverId}`)
      .order("stack_position", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: true });

    for (const row of queuedRows ?? []) {
      if (typeof row.id === "string" && row.id) queuedIds.push(row.id);
    }
  }

  if (queuedIds.length === 0) {
    const { data: currentTrip } = await supabase
      .from("trips")
      .select("stacked_trip_id")
      .eq("id", currentTripId)
      .maybeSingle();

    const linkedId = currentTrip?.stacked_trip_id as string | null | undefined;
    if (linkedId) queuedIds.push(linkedId);
  }

  if (queuedIds.length === 0) {
    return { handled: false, action: "skipped", detail: "no_stacked_trip_id" };
  }

  const promoteReasons: StackedCurrentTripFailureReason[] = [
    "pickup_no_show",
    "customer_cancel",
  ];
  const redispatchReasons: StackedCurrentTripFailureReason[] = [
    "driver_cancel_before_pickup",
    "driver_cancel_terminal",
    "payment_failure",
    "driver_offline",
  ];

  // Promote path: promote head once (RPC re-links remaining queue onto new active).
  if (promoteReasons.includes(failureReason) && driverId) {
    const headId = queuedIds[0]!;
    const result = await promoteQueuedStackedTrip(
      supabase,
      driverId,
      currentTripId,
      headId,
      failureReason,
    );
    if (result.handled) return result;
    // Fall through: redispatch every remaining queued trip.
  }

  let last: LifecycleResult = {
    handled: false,
    queued_trip_id: queuedIds[0],
    action: "skipped",
  };

  for (const queuedTripId of queuedIds) {
    if (redispatchReasons.includes(failureReason) || promoteReasons.includes(failureReason)) {
      last = await redispatchQueuedStackedTrip(
        supabase,
        currentTripId,
        queuedTripId,
        failureReason,
      );
      continue;
    }
    last = await cancelQueuedStackedTrip(
      supabase,
      currentTripId,
      queuedTripId,
      failureReason,
    );
  }

  return last;
}

/**
 * Driver rejected/cancelled queued Trip B while Trip A is active.
 * Unlinks parent, re-dispatches Trip B — does NOT clear Trip A or driver current_trip_id.
 */
export async function handleQueuedTripDriverCancel(
  supabase: SupabaseClient,
  queuedTripId: string,
  driverId: string,
): Promise<LifecycleResult> {
  const now = new Date().toISOString();

  const { data: parents } = await supabase
    .from("trips")
    .select("id, driver_id, confirmed_driver_id")
    .eq("stacked_trip_id", queuedTripId);

  await clearStackedTripLinks(supabase, {
    queuedTripId,
    reason: "driver_cancel_queued",
    failureReason: "driver_cancel_queued",
  });

  for (const parent of parents ?? []) {
    const parentDriverId =
      (typeof parent.driver_id === "string" && parent.driver_id) ||
      (typeof parent.confirmed_driver_id === "string" && parent.confirmed_driver_id) ||
      driverId;
    await relinkParentToNextQueued(supabase, parent.id, parentDriverId, queuedTripId);
  }
  const { data: queuedTrip } = await supabase
    .from("trips")
    .select("id, status, cancelled_driver_ids")
    .eq("id", queuedTripId)
    .maybeSingle();

  if (!queuedTrip || queuedTrip.status !== "queued") {
    logLifecycle(STACKED_RIDE_ORPHAN_PREVENTED, {
      queued_trip_id: queuedTripId,
      driver_id: driverId,
      action: "driver_cancel_queued",
      queued_status: queuedTrip?.status ?? "missing",
    });
    return {
      handled: true,
      queued_trip_id: queuedTripId,
      action: "unlinked",
      detail: "queued_trip_not_active",
    };
  }

  const priorCancelled = Array.isArray(queuedTrip.cancelled_driver_ids)
    ? (queuedTrip.cancelled_driver_ids as string[])
    : [];
  const cancelledDriverIds = priorCancelled.includes(driverId)
    ? priorCancelled
    : [...priorCancelled, driverId];

  const { error: resetErr } = await supabase
    .from("trips")
    .update({
      status: "searching",
      dispatch_status: "stacked_rebroadcasting",
      driver_id: null,
      confirmed_driver_id: null,
      cancelled_driver_ids: cancelledDriverIds,
      stack_position: null,
      updated_at: now,
    })
    .eq("id", queuedTripId)
    .eq("status", "queued");

  if (resetErr) {
    logLifecycle(STACKED_RIDE_ORPHAN_PREVENTED, {
      queued_trip_id: queuedTripId,
      driver_id: driverId,
      reset_error: resetErr.message,
      action: "driver_cancel_queued",
    });
    return {
      handled: false,
      queued_trip_id: queuedTripId,
      action: "skipped",
      detail: resetErr.message,
    };
  }

  const dispatchResult = await rebroadcastTripViaAutoDispatch(
    supabase,
    queuedTripId,
    "stacked_driver_cancelled_queued",
  );

  logLifecycle(STACKED_RIDE_DRIVER_QUEUED_CANCEL, {
    queued_trip_id: queuedTripId,
    driver_id: driverId,
    parent_trip_ids: parents?.map((p) => p.id) ?? [],
    dispatch_ok: dispatchResult.ok,
    dispatch_path: dispatchResult.path,
    dispatch_error: dispatchResult.error ?? null,
  });

  logLifecycle(STACKED_RIDE_REDISPATCHED, {
    queued_trip_id: queuedTripId,
    driver_id: driverId,
    failure_reason: "driver_cancel_queued",
    dispatch_ok: dispatchResult.ok,
    dispatch_path: dispatchResult.path,
    dispatch_error: dispatchResult.error ?? null,
  });

  return {
    handled: true,
    queued_trip_id: queuedTripId,
    action: "redispatched",
    detail: dispatchResult.error,
  };
}

/** Server-side promotion backup after Trip A completes (idempotent with client RPC). */
export async function tryPromoteStackedTripAfterCompletion(
  supabase: SupabaseClient,
  driverId: string,
  completedTripId: string,
): Promise<{ promoted: boolean; detail?: string }> {
  const { data, error } = await supabase.rpc("promote_stacked_trip", {
    p_driver_id: driverId,
    p_completed_trip_id: completedTripId,
  });

  if (error) {
    console.log(STACKED_RIDE_ORPHAN_PREVENTED, {
      current_trip_id: completedTripId,
      driver_id: driverId,
      promote_error: error.message,
      action: "server_promotion_backup",
    });
    return { promoted: false, detail: error.message };
  }

  const promoted = data?.promoted === true;
  if (promoted) {
    logLifecycle(STACKED_RIDE_PROMOTED, {
      current_trip_id: completedTripId,
      queued_trip_id: data?.trip_id ?? null,
      driver_id: driverId,
      failure_reason: "trip_a_complete",
      rpc_result: data,
      source: "stop_workflow_backup",
    });
  }

  return { promoted, detail: data?.reason ?? data?.detail };
}

/**
 * Server-side stacked promotion after payment confirm (post-trip reliability).
 * Idempotent — safe if client also calls promote_stacked_trip at rating done.
 * Always invoke RPC: prefers stacked_trip_id, else ORDER BY stack_position
 * (required for Admin max 2–3 when the head link was cleared).
 */
export async function attemptStackedTripPromotionAfterComplete(
  supabase: SupabaseClient,
  driverId: string,
  completedTripId: string,
): Promise<LifecycleResult> {
  const { data: completedTrip } = await supabase
    .from("trips")
    .select("stacked_trip_id, status")
    .eq("id", completedTripId)
    .maybeSingle();

  const linkedId = (completedTrip?.stacked_trip_id as string | null | undefined) ?? null;

  const { data, error } = await supabase.rpc("promote_stacked_trip", {
    p_driver_id: driverId,
    p_completed_trip_id: completedTripId,
  });

  if (error) {
    logLifecycle(STACKED_RIDE_ORPHAN_PREVENTED, {
      current_trip_id: completedTripId,
      queued_trip_id: linkedId,
      driver_id: driverId,
      promote_error: error.message,
      source: "confirm_trip_payment",
    });
    return { handled: false, action: "skipped", detail: error.message };
  }

  if (data?.promoted === true) {
    const promotedId =
      (typeof data.trip_id === "string" && data.trip_id) || linkedId || undefined;
    logLifecycle(STACKED_RIDE_PROMOTED, {
      current_trip_id: completedTripId,
      queued_trip_id: promotedId ?? null,
      driver_id: driverId,
      source: "confirm_trip_payment",
      rpc_result: data,
    });
    return {
      handled: true,
      queued_trip_id: promotedId,
      action: "promoted",
    };
  }

  return {
    handled: false,
    queued_trip_id: linkedId ?? undefined,
    action: "skipped",
    detail: data?.reason ?? "not_promoted",
  };
}

/** Re-point parent.stacked_trip_id to next remaining queued trip (max 2–3). */
async function relinkParentToNextQueued(
  supabase: SupabaseClient,
  parentTripId: string,
  driverId: string | null,
  excludeQueuedTripId: string,
): Promise<string | null> {
  if (!driverId) return null;
  const { data: next } = await supabase
    .from("trips")
    .select("id")
    .eq("status", "queued")
    .or(`driver_id.eq.${driverId},confirmed_driver_id.eq.${driverId}`)
    .neq("id", excludeQueuedTripId)
    .order("stack_position", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  const nextId = typeof next?.id === "string" ? next.id : null;
  const now = new Date().toISOString();
  await supabase
    .from("trips")
    .update({ stacked_trip_id: nextId, updated_at: now })
    .eq("id", parentTripId);
  return nextId;
}

/** Customer cancelled queued Trip B — unlink from parent Trip A; keep remaining queue linked. */
export async function handleQueuedTripCustomerCancel(
  supabase: SupabaseClient,
  queuedTripId: string,
): Promise<LifecycleResult> {
  const { data: parents } = await supabase
    .from("trips")
    .select("id, driver_id, confirmed_driver_id")
    .eq("stacked_trip_id", queuedTripId);

  if (!parents?.length) {
    return { handled: false, action: "skipped", detail: "no_parent_link" };
  }

  await clearStackedTripLinks(supabase, {
    queuedTripId,
    reason: "customer_cancel_queued_unlink",
  });

  for (const parent of parents) {
    const driverId =
      (typeof parent.driver_id === "string" && parent.driver_id) ||
      (typeof parent.confirmed_driver_id === "string" && parent.confirmed_driver_id) ||
      null;
    await relinkParentToNextQueued(supabase, parent.id, driverId, queuedTripId);
  }

  logLifecycle(STACKED_RIDE_ORPHAN_PREVENTED, {
    queued_trip_id: queuedTripId,
    parent_trip_ids: parents.map((p) => p.id),
    action: "customer_cancel_unlinked",
  });

  return { handled: true, queued_trip_id: queuedTripId, action: "unlinked" };
}

/**
 * Driver went offline while Trip A is active with queued Trip B.
 * Re-dispatch Trip B — driver fault; Trip A lifecycle is handled elsewhere.
 */
export async function handleStackedTripsOnDriverOffline(
  supabase: SupabaseClient,
  driverId: string,
): Promise<LifecycleResult> {
  const { data: driver } = await supabase
    .from("drivers")
    .select("current_trip_id")
    .eq("id", driverId)
    .maybeSingle();

  const currentTripId = driver?.current_trip_id as string | null | undefined;
  if (!currentTripId) {
    return { handled: false, action: "skipped", detail: "no_current_trip" };
  }

  return handleQueuedTripAfterCurrentTripFailure(supabase, {
    currentTripId,
    driverId,
    failureReason: "driver_offline",
  });
}

/**
 * Trip A payment capture/confirm failed while queued Trip B is linked.
 * Completed Trip A → promote B; terminal failure → re-dispatch/cancel B.
 */
export async function handleQueuedTripAfterPaymentFailure(
  supabase: SupabaseClient,
  params: {
    currentTripId: string;
    driverId: string | null;
    paymentStatus?: string | null;
  },
): Promise<LifecycleResult> {
  const { data: currentTrip } = await supabase
    .from("trips")
    .select("status, stacked_trip_id")
    .eq("id", params.currentTripId)
    .maybeSingle();

  const linkedId = (currentTrip?.stacked_trip_id as string | null | undefined) ?? null;

  if (String(currentTrip?.status ?? "").toLowerCase() === "completed" && params.driverId) {
    const promo = await attemptStackedTripPromotionAfterComplete(
      supabase,
      params.driverId,
      params.currentTripId,
    );
    if (promo.handled && promo.action === "promoted") {
      return {
        handled: true,
        queued_trip_id: promo.queued_trip_id ?? linkedId ?? undefined,
        action: "promoted",
      };
    }
    logStackedPromotionSkipped({
      current_trip_id: params.currentTripId,
      queued_trip_id: linkedId,
      payment_status: params.paymentStatus ?? null,
      detail: promo.detail,
    });
    // Fall through to multi-queue failure handling when promote did not run.
  }

  logLifecycle(STACKED_RIDE_ORPHAN_PREVENTED, {
    current_trip_id: params.currentTripId,
    driver_id: params.driverId,
    payment_status: params.paymentStatus ?? null,
    trip_status: currentTrip?.status ?? null,
    action: "payment_failure_lifecycle",
  });

  return handleQueuedTripAfterCurrentTripFailure(supabase, {
    currentTripId: params.currentTripId,
    driverId: params.driverId,
    failureReason: "payment_failure",
  });
}
