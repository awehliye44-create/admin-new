/**
 * Cancellation outcome resolver — SSOT for cancel-trip / stop-workflow alignment.
 * Delegates lifecycle rules to tripLifecycleTransitionMatrix; rematch eligibility
 * to driverCancelRematch.
 */

import { isPrePickupDriverRematchEligibleDbStatus } from "./driverCancelRematch.ts";
import {
  mapEdgeActionToMatrixAction,
  resolveLifecycleTransition,
  type LifecycleActor,
  type LifecycleSideEffects,
  type LifecycleTransitionContext,
  type MatrixLifecycleAction,
} from "./tripLifecycleTransitionMatrix.ts";
import { isTerminalTripLifecycleStatus, normalizeTripLifecycleDbStatus } from "./tripLifecycle.ts";

export type CancellationActor = "driver" | "customer" | "admin" | "rider";

export type CancellationOutcomeKind =
  | "rematch"
  | "terminal_cancel"
  | "no_show"
  | "reject";

export type PaymentHint = LifecycleSideEffects["payment"];

export type CancellationOutcomeInput = {
  actor: CancellationActor;
  status: string;
  startedAt?: string | null;
  arrivedAt?: string | null;
  dispatchStatus?: string | null;
  isNoShow?: boolean;
  driverId?: string | null;
  confirmedDriverId?: string | null;
  isQueued?: boolean;
};

export type CancellationOutcome = {
  kind: CancellationOutcomeKind;
  lifecycle_action: MatrixLifecycleAction;
  resulting_status: string | null;
  resulting_dispatch_status: string | null;
  clear_assignment: boolean;
  rematch_eligible: boolean;
  exclude_cancelling_driver: boolean;
  payment_hint: PaymentHint;
  allowed: boolean;
  idempotent: boolean;
  error_code?: string;
  reason?: string;
};

function mapCancelActor(actor: CancellationActor): LifecycleActor {
  if (actor === "rider") return "customer";
  return actor;
}

function tripStarted(input: CancellationOutcomeInput): boolean {
  return Boolean(input.startedAt) ||
    ["in_progress", "on_trip", "started", "ongoing", "passenger_onboard"].includes(
      normalizeTripLifecycleDbStatus(input.status),
    );
}

function buildLifecycleContext(input: CancellationOutcomeInput): LifecycleTransitionContext {
  const driverId = input.confirmedDriverId ?? input.driverId ?? null;
  const queued = input.isQueued ??
    normalizeTripLifecycleDbStatus(input.status) === "queued";
  return {
    status: input.status,
    started_at: input.startedAt ?? null,
    arrived_at: input.arrivedAt ?? null,
    dispatch_status: input.dispatchStatus ?? null,
    assignment: {
      driver_id: input.driverId ?? driverId,
      confirmed_driver_id: input.confirmedDriverId ?? driverId,
      is_driver_active_trip: !queued,
    },
    queue: { is_queued: queued },
    waiting: { arrived_at: input.arrivedAt ?? null },
    acting_driver_id: input.actor === "driver" ? driverId : null,
  };
}

function assignmentClears(
  effect: LifecycleSideEffects["assignment"] | undefined,
): boolean {
  return effect === "clear" || effect === "exclude_and_clear";
}

function assignmentExcludesDriver(
  effect: LifecycleSideEffects["assignment"] | undefined,
): boolean {
  return effect === "exclude_and_clear";
}

function resolveKind(
  action: MatrixLifecycleAction,
  matrixResult: ReturnType<typeof resolveLifecycleTransition>,
  input: CancellationOutcomeInput,
): CancellationOutcomeKind {
  const normalizedStatus = normalizeTripLifecycleDbStatus(input.status);

  if (action === "passenger_no_show") {
    return "no_show";
  }

  if (
    action === "driver_cancel_before_start" ||
    action === "rematch" ||
    (input.actor === "driver" && !input.isNoShow && isPrePickupDriverRematchEligibleDbStatus(input.status))
  ) {
    if (matrixResult.allowed && matrixResult.resulting_status === "searching_new_driver") {
      return "rematch";
    }
    if (!matrixResult.allowed && matrixResult.error_code === "INVALID_TRIP_STATE" && tripStarted(input)) {
      return "terminal_cancel";
    }
  }

  if (
    matrixResult.idempotent &&
    (normalizedStatus === "no_show" || normalizedStatus === "no-show")
  ) {
    return "no_show";
  }

  if (matrixResult.idempotent && isTerminalTripLifecycleStatus(input.status)) {
    return normalizedStatus === "no_show" || normalizedStatus === "no-show"
      ? "no_show"
      : "terminal_cancel";
  }

  if (!matrixResult.allowed) {
    return "reject";
  }

  if (action === "driver_cancel_after_start" || action === "customer_cancel" || action === "admin_cancel") {
    return "terminal_cancel";
  }

  if (matrixResult.resulting_status === "searching_new_driver") {
    return "rematch";
  }

  return "terminal_cancel";
}

/**
 * Resolve cancellation kind, lifecycle action, and side-effect hints for cancel paths.
 */
export function resolveCancellationOutcome(
  input: CancellationOutcomeInput,
): CancellationOutcome {
  const lifecycleActor = mapCancelActor(input.actor);
  const ctx = buildLifecycleContext(input);

  let lifecycleAction: MatrixLifecycleAction;

  if (input.isNoShow && input.actor === "driver") {
    lifecycleAction = "passenger_no_show";
  } else if (input.actor === "driver") {
    lifecycleAction = mapEdgeActionToMatrixAction("driver_cancel", {
      tripStarted: tripStarted(input),
      isQueued: ctx.queue?.is_queued ?? false,
    }) ?? "driver_cancel_before_start";
  } else if (input.actor === "admin") {
    lifecycleAction = "admin_cancel";
  } else {
    lifecycleAction = "customer_cancel";
  }

  const matrixResult = resolveLifecycleTransition(lifecycleAction, lifecycleActor, ctx);
  const kind = resolveKind(lifecycleAction, matrixResult, input);
  const assignmentEffect = matrixResult.side_effects?.assignment;

  const rematchEligible = kind === "rematch" ||
    (input.actor === "driver" &&
      !input.isNoShow &&
      isPrePickupDriverRematchEligibleDbStatus(input.status) &&
      !tripStarted(input));

  return {
    kind,
    lifecycle_action: lifecycleAction,
    resulting_status: matrixResult.resulting_status ?? null,
    resulting_dispatch_status: matrixResult.resulting_dispatch_status ?? null,
    clear_assignment: assignmentClears(assignmentEffect),
    rematch_eligible: rematchEligible,
    exclude_cancelling_driver: assignmentExcludesDriver(assignmentEffect) || rematchEligible,
    payment_hint: matrixResult.side_effects?.payment ?? "unchanged",
    allowed: matrixResult.allowed,
    idempotent: Boolean(matrixResult.idempotent),
    error_code: matrixResult.error_code,
    reason: matrixResult.reason,
  };
}
