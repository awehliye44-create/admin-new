/**
 * Formal Trip Lifecycle transition matrix — extension of tripLifecycle.ts SSOT.
 *
 * One model: physical status + dispatch_status + assignment + queue + waiting
 * + modification version + payment side-effects. Edge Functions must reuse
 * resolveLifecycleTransition / assertTripLifecycleInvariants — do not fork rules.
 */

import {
  hasPendingIntermediateStops,
  isTerminalTripLifecycleStatus,
  normalizeTripLifecycleDbStatus,
  resolveCanonicalTripLifecycleState,
  validateTripActionTransition,
  type CanonicalTripLifecycleState,
  type TripLifecycleAction,
  type TripLifecycleTripFields,
  type TripLifecycleValidationResult,
  type TripStopRecord,
} from "./tripLifecycle.ts";

/** Authorised actors for lifecycle actions. */
export type LifecycleActor =
  | "driver"
  | "customer"
  | "admin"
  | "system"
  | "service_role";

/** Stable error codes for clients (never raw SQL). */
export type LifecycleErrorCode =
  | "TRIP_NOT_FOUND"
  | "NOT_ASSIGNED_DRIVER"
  | "INVALID_TRIP_STATE"
  | "INVALID_DISPATCH_STATE"
  | "INVALID_ASSIGNMENT_STATE"
  | "INVALID_QUEUE_STATE"
  | "ACTION_ALREADY_COMPLETED"
  | "STALE_TRIP_VERSION"
  | "WAITING_NOT_ELIGIBLE"
  | "NO_SHOW_NOT_ELIGIBLE"
  | "MODIFICATION_NOT_ALLOWED"
  | "QUEUED_TRIP_NOT_CANCELLABLE"
  | "PAYMENT_PROCESSING"
  | "SETTLEMENT_PROCESSING"
  | "OFFER_EXPIRED"
  | "ASSIGNMENT_CHANGED"
  | "STOPS_INCOMPLETE"
  | "INVARIANT_VIOLATION"
  | "UNAUTHORIZED_ACTOR";

/**
 * Production dispatch_status values observed in migrations / Edges.
 * Do not rename — clients map presentation separately.
 */
export const KNOWN_DISPATCH_STATUSES = [
  "searching",
  "broadcasting",
  "offered",
  "locked_driver_offered",
  "assigned",
  "searching_new_driver",
  "stacked_rebroadcasting",
  "paused",
  "expired",
  "search_timeout",
  "cancelled",
  "completed",
  "no_show",
] as const;

export type KnownDispatchStatus = (typeof KNOWN_DISPATCH_STATUSES)[number];

/**
 * Extended actions beyond stop-workflow physical progression.
 * Physical actions still use TripLifecycleAction via mapMatrixActionToPhysical.
 */
export type MatrixLifecycleAction =
  | TripLifecycleAction
  | "accept_scheduled"
  | "begin_pickup_waiting"
  | "passenger_no_show"
  | "driver_cancel_before_start"
  | "driver_cancel_after_start"
  | "customer_cancel"
  | "admin_cancel"
  | "rematch"
  | "cancel_queued_trip"
  | "promote_queued_trip"
  | "pre_trip_modification"
  | "in_trip_modification"
  | "payment_capture"
  | "settlement_complete";

export type LifecycleAssignmentSnapshot = {
  driver_id?: string | null;
  confirmed_driver_id?: string | null;
  /** True when trip is the driver's current physical active trip (not queued). */
  is_driver_active_trip?: boolean | null;
};

export type LifecycleQueueSnapshot = {
  /** trips.status === 'queued' */
  is_queued?: boolean | null;
  stack_position?: number | null;
};

export type LifecycleWaitingSnapshot = {
  arrived_at?: string | null;
  pickup_arrived_at?: string | null;
  pickup_waiting_started_at?: string | null;
  pickup_paid_waiting_started_at?: string | null;
  free_wait_expires_at?: string | null;
};

export type LifecyclePaymentSnapshot = {
  payment_status?: string | null;
  payment_state?: string | null;
};

export type LifecycleVersionSnapshot = {
  trip_version?: number | null;
  pricing_version?: number | null;
  fare_revision_number?: number | null;
  client_trip_version?: number | null;
};

export type LifecycleTransitionContext = TripLifecycleTripFields & {
  dispatch_status?: string | null;
  assignment?: LifecycleAssignmentSnapshot;
  queue?: LifecycleQueueSnapshot;
  waiting?: LifecycleWaitingSnapshot;
  payment?: LifecyclePaymentSnapshot;
  version?: LifecycleVersionSnapshot;
  /** Acting driver id when actor is driver (resolved server-side). */
  acting_driver_id?: string | null;
};

export type LifecycleSideEffects = {
  assignment: "unchanged" | "set_assigned" | "clear" | "exclude_and_clear";
  queue: "unchanged" | "enqueue" | "dequeue" | "promote_to_active" | "cancel_queued";
  waiting: "unchanged" | "start_free_wait" | "start_paid_wait" | "finalise" | "clear";
  customer_live_location: "unchanged" | "allow_if_policy" | "hide" | "clear";
  modification_allowed: boolean;
  payment: "unchanged" | "capture_pending" | "settle" | "no_show_fee" | "cancel_auth";
  notify: ("customer" | "driver" | "admin")[];
};

export type LifecycleTransitionResult = TripLifecycleValidationResult & {
  action: MatrixLifecycleAction;
  actor: LifecycleActor;
  error_code?: LifecycleErrorCode;
  resulting_status?: string | null;
  resulting_dispatch_status?: string | null;
  side_effects?: LifecycleSideEffects;
  invariants_ok?: boolean;
  invariant_violations?: string[];
};

function normDispatch(raw: string | null | undefined): string {
  return normalizeTripLifecycleDbStatus(raw);
}

function assignedDriverId(ctx: LifecycleTransitionContext): string | null {
  const a = ctx.assignment;
  const id = a?.confirmed_driver_id || a?.driver_id || null;
  return id ? String(id) : null;
}

function isQueued(ctx: LifecycleTransitionContext): boolean {
  if (ctx.queue?.is_queued === true) return true;
  return normalizeTripLifecycleDbStatus(ctx.status) === "queued";
}

function hasStarted(ctx: LifecycleTransitionContext): boolean {
  return Boolean(ctx.started_at) ||
    ["in_progress", "on_trip", "started", "ongoing", "passenger_onboard"].includes(
      normalizeTripLifecycleDbStatus(ctx.status),
    );
}

function hasArrivedPickup(ctx: LifecycleTransitionContext): boolean {
  return Boolean(
    ctx.waiting?.pickup_arrived_at ||
      ctx.waiting?.arrived_at ||
      ctx.arrived_at ||
      [
        "arrived",
        "arrived_pickup",
        "arrived_at_pickup",
        "at_pickup",
        "pickup_waiting",
        "waiting",
        "driver_arrived",
        "waiting_at_pickup",
      ].includes(normalizeTripLifecycleDbStatus(ctx.status)),
  );
}

/**
 * Illegal combinations that must never be written / must be rejected when present
 * as a target outcome. Logging via trip_state_violations remains the ops path;
 * destructive CHECK constraints are deferred until production rows are clean.
 */
export function assertTripLifecycleInvariants(
  ctx: LifecycleTransitionContext,
  stops: TripStopRecord[] = [],
): { ok: boolean; violations: string[] } {
  const violations: string[] = [];
  const status = normalizeTripLifecycleDbStatus(ctx.status);
  const dispatch = normDispatch(ctx.dispatch_status);
  const driver = assignedDriverId(ctx);
  const queued = isQueued(ctx);
  const state = resolveCanonicalTripLifecycleState(ctx, stops);

  if (status === "completed" && (dispatch === "assigned" || dispatch === "broadcasting")) {
    violations.push("completed_with_active_dispatch");
  }
  if (
    (status === "cancelled" || status.includes("cancelled")) &&
    dispatch === "assigned" &&
    driver
  ) {
    violations.push("cancelled_with_assigned_driver");
  }
  if (status === "no_show" && driver) {
    violations.push("no_show_with_assigned_driver");
  }
  if (queued && hasStarted(ctx) && ctx.assignment?.is_driver_active_trip === true) {
    violations.push("queued_and_active_simultaneously");
  }
  if (queued && state === "IN_PROGRESS") {
    violations.push("queued_marked_in_progress");
  }
  if (
    (state === "IN_PROGRESS" ||
      state === "EN_ROUTE_TO_STOP" ||
      state === "ARRIVED_AT_STOP" ||
      state === "EN_ROUTE_TO_DESTINATION") &&
    !driver &&
    !queued
  ) {
    violations.push("in_progress_without_assigned_driver");
  }
  if (status === "completed" && hasPendingIntermediateStops(stops)) {
    violations.push("completed_with_pending_intermediate_stops");
  }
  if (
    ctx.acting_driver_id &&
    driver &&
    ctx.acting_driver_id !== driver &&
    ctx.assignment?.is_driver_active_trip === true
  ) {
    violations.push("active_driver_points_to_different_trip_assignment");
  }
  if (queued && ctx.assignment?.is_driver_active_trip === true) {
    violations.push("queued_trip_occupying_active_trip_state");
  }

  return { ok: violations.length === 0, violations };
}

function requireAssignedDriver(
  ctx: LifecycleTransitionContext,
  actor: LifecycleActor,
): LifecycleErrorCode | null {
  if (actor !== "driver") return null;
  const assigned = assignedDriverId(ctx);
  if (!assigned) return "NOT_ASSIGNED_DRIVER";
  if (ctx.acting_driver_id && ctx.acting_driver_id !== assigned) {
    return "NOT_ASSIGNED_DRIVER";
  }
  return null;
}

function mapToPhysicalAction(
  action: MatrixLifecycleAction,
): TripLifecycleAction | null {
  switch (action) {
    case "accept_scheduled":
      return "accept_offer";
    case "begin_pickup_waiting":
      return "arrive_pickup";
    case "passenger_no_show":
    case "driver_cancel_before_start":
    case "driver_cancel_after_start":
    case "customer_cancel":
    case "admin_cancel":
    case "cancel_queued_trip":
      return "cancel_trip";
    case "rematch":
    case "promote_queued_trip":
    case "pre_trip_modification":
    case "in_trip_modification":
    case "payment_capture":
    case "settlement_complete":
      return null;
    default:
      return action;
  }
}

function defaultSideEffects(): LifecycleSideEffects {
  return {
    assignment: "unchanged",
    queue: "unchanged",
    waiting: "unchanged",
    customer_live_location: "unchanged",
    modification_allowed: true,
    payment: "unchanged",
    notify: [],
  };
}

/**
 * Authoritative transition resolver for all ONECAB lifecycle actors.
 * Reuses validateTripActionTransition for physical progression.
 */
export function resolveLifecycleTransition(
  action: MatrixLifecycleAction,
  actor: LifecycleActor,
  ctx: LifecycleTransitionContext,
  stops: TripStopRecord[] = [],
): LifecycleTransitionResult {
  const invariants = assertTripLifecycleInvariants(ctx, stops);
  const status = normalizeTripLifecycleDbStatus(ctx.status);
  const dispatch = normDispatch(ctx.dispatch_status);
  const state = resolveCanonicalTripLifecycleState(ctx, stops);

  const base: LifecycleTransitionResult = {
    action,
    actor,
    allowed: false,
    current_state: state,
    invariants_ok: invariants.ok,
    invariant_violations: invariants.violations,
  };

  // Version guard for modifications
  if (
    (action === "pre_trip_modification" || action === "in_trip_modification") &&
    ctx.version?.client_trip_version != null &&
    ctx.version?.trip_version != null &&
    ctx.version.client_trip_version !== ctx.version.trip_version
  ) {
    return {
      ...base,
      error_code: "STALE_TRIP_VERSION",
      reason: "Trip version conflict — refresh and retry.",
    };
  }

  // Queued trips cannot progress physically until promoted
  if (
    isQueued(ctx) &&
    [
      "arrive_pickup",
      "begin_pickup_waiting",
      "start_trip",
      "arrive_stop",
      "drive_to_next",
      "continue_journey",
      "complete_trip",
      "passenger_no_show",
    ].includes(action)
  ) {
    return {
      ...base,
      error_code: "INVALID_QUEUE_STATE",
      reason: "Queued stacked ride cannot progress before promotion.",
    };
  }

  // ── Accept family ──────────────────────────────────────────────
  if (
    action === "accept_offer" ||
    action === "accept_fare" ||
    action === "accept_standard" ||
    action === "accept_stacked" ||
    action === "accept_scheduled"
  ) {
    if (actor !== "driver" && actor !== "system" && actor !== "service_role") {
      return { ...base, error_code: "UNAUTHORIZED_ACTOR", reason: "Only a driver may accept." };
    }
    const physical = validateTripActionTransition(
      action === "accept_scheduled" ? "accept_offer" : action,
      ctx,
      stops,
    );
    if (!physical.allowed) {
      return {
        ...base,
        ...physical,
        error_code: physical.idempotent
          ? "ACTION_ALREADY_COMPLETED"
          : "INVALID_TRIP_STATE",
      };
    }
    const effects = defaultSideEffects();
    effects.assignment = "set_assigned";
    effects.queue = action === "accept_stacked" ? "enqueue" : "unchanged";
    effects.customer_live_location =
      action === "accept_stacked" ? "unchanged" : "allow_if_policy";
    effects.notify = ["customer", "admin"];
    effects.modification_allowed = true;
    return {
      ...base,
      ...physical,
      allowed: true,
      // Production accept_ride_offer writes status=driver_assigned (not legacy "accepted").
      resulting_status: action === "accept_stacked" ? "queued" : "driver_assigned",
      resulting_dispatch_status: "assigned",
      side_effects: effects,
    };
  }

  // ── Arrive + waiting ───────────────────────────────────────────
  if (action === "arrive_pickup" || action === "begin_pickup_waiting") {
    const assignErr = requireAssignedDriver(ctx, actor);
    if (assignErr) {
      return { ...base, error_code: assignErr, reason: "Driver is not assigned to this trip." };
    }
    const physical = validateTripActionTransition("arrive_pickup", ctx, stops);
    if (!physical.allowed && !physical.idempotent) {
      return { ...base, ...physical, error_code: "INVALID_TRIP_STATE" };
    }
    const effects = defaultSideEffects();
    effects.waiting = "start_free_wait";
    effects.customer_live_location = "allow_if_policy";
    effects.notify = ["customer", "admin"];
    effects.modification_allowed = true;
    return {
      ...base,
      ...physical,
      allowed: true,
      resulting_status: "arrived_at_pickup",
      resulting_dispatch_status: dispatch || "assigned",
      side_effects: effects,
      idempotent: physical.idempotent || hasArrivedPickup(ctx),
    };
  }

  // ── Start trip ─────────────────────────────────────────────────
  if (action === "start_trip") {
    const assignErr = requireAssignedDriver(ctx, actor);
    if (assignErr) {
      return { ...base, error_code: assignErr, reason: "Driver is not assigned to this trip." };
    }
    const physical = validateTripActionTransition("start_trip", ctx, stops);
    if (!physical.allowed && !physical.idempotent) {
      return { ...base, ...physical, error_code: "INVALID_TRIP_STATE" };
    }
    const effects = defaultSideEffects();
    effects.waiting = "finalise";
    effects.customer_live_location = "hide";
    effects.notify = ["customer", "admin"];
    effects.modification_allowed = true;
    return {
      ...base,
      ...physical,
      allowed: true,
      resulting_status: "in_progress",
      resulting_dispatch_status: "assigned",
      side_effects: effects,
    };
  }

  // ── Multi-stop ─────────────────────────────────────────────────
  if (
    action === "arrive_stop" ||
    action === "drive_to_next" ||
    action === "continue_journey"
  ) {
    const assignErr = requireAssignedDriver(ctx, actor);
    if (assignErr) {
      return { ...base, error_code: assignErr, reason: "Driver is not assigned to this trip." };
    }
    const physical = validateTripActionTransition(action, ctx, stops);
    if (!physical.allowed) {
      return { ...base, ...physical, error_code: "INVALID_TRIP_STATE" };
    }
    const effects = defaultSideEffects();
    effects.notify = ["customer"];
    return {
      ...base,
      ...physical,
      allowed: true,
      resulting_status: "in_progress",
      resulting_dispatch_status: "assigned",
      side_effects: effects,
    };
  }

  // ── Complete ───────────────────────────────────────────────────
  if (action === "complete_trip") {
    const assignErr = requireAssignedDriver(ctx, actor);
    if (assignErr) {
      return { ...base, error_code: assignErr, reason: "Driver is not assigned to this trip." };
    }
    if (hasPendingIntermediateStops(stops)) {
      return {
        ...base,
        error_code: "STOPS_INCOMPLETE",
        reason: "Complete trip blocked — intermediate stops remain.",
        current_state: state,
      };
    }
    const physical = validateTripActionTransition("complete_trip", ctx, stops);
    if (!physical.allowed && !physical.idempotent) {
      return { ...base, ...physical, error_code: "INVALID_TRIP_STATE" };
    }
    const effects = defaultSideEffects();
    effects.assignment = "clear";
    effects.queue = "promote_to_active";
    effects.waiting = "clear";
    effects.customer_live_location = "clear";
    effects.modification_allowed = false;
    effects.payment = "capture_pending";
    effects.notify = ["customer", "driver", "admin"];
    return {
      ...base,
      ...physical,
      allowed: true,
      resulting_status: "completed",
      resulting_dispatch_status: "completed",
      side_effects: effects,
    };
  }

  // ── Passenger no-show ──────────────────────────────────────────
  if (action === "passenger_no_show") {
    const assignErr = requireAssignedDriver(ctx, actor);
    if (assignErr) {
      return { ...base, error_code: assignErr, reason: "Driver is not assigned to this trip." };
    }
    if (actor !== "driver" && actor !== "admin" && actor !== "service_role") {
      return { ...base, error_code: "UNAUTHORIZED_ACTOR" };
    }
    if (status === "no_show") {
      return {
        ...base,
        allowed: true,
        idempotent: true,
        next_state: "CANCELLED",
        resulting_status: "no_show",
        resulting_dispatch_status: "no_show",
        error_code: "ACTION_ALREADY_COMPLETED",
        side_effects: {
          ...defaultSideEffects(),
          assignment: "clear",
          customer_live_location: "clear",
          modification_allowed: false,
          payment: "no_show_fee",
          notify: [],
        },
      };
    }
    if (!hasArrivedPickup(ctx) || hasStarted(ctx) || isTerminalTripLifecycleStatus(ctx.status)) {
      return {
        ...base,
        error_code: "NO_SHOW_NOT_ELIGIBLE",
        reason: "No-show requires arrived/waiting state before trip start.",
      };
    }
    // Eligibility threshold is enforced by Edge using server waiting config —
    // matrix only gates state; Edge supplies remaining_seconds / can_mark_no_show.
    const effects = defaultSideEffects();
    effects.assignment = "clear";
    effects.waiting = "finalise";
    effects.customer_live_location = "clear";
    effects.modification_allowed = false;
    effects.payment = "no_show_fee";
    effects.notify = ["customer", "admin"];
    return {
      ...base,
      allowed: true,
      current_state: state,
      next_state: "CANCELLED",
      resulting_status: "no_show",
      resulting_dispatch_status: "no_show",
      side_effects: effects,
    };
  }

  // ── Driver cancel before start → rematch (customer trip survives) ─
  if (action === "driver_cancel_before_start" || action === "rematch") {
    if (actor !== "driver" && actor !== "system" && actor !== "service_role") {
      return { ...base, error_code: "UNAUTHORIZED_ACTOR" };
    }
    const assignErr = requireAssignedDriver(ctx, actor === "driver" ? "driver" : actor);
    if (actor === "driver" && assignErr) {
      return { ...base, error_code: assignErr };
    }
    if (hasStarted(ctx) && action === "driver_cancel_before_start") {
      return {
        ...base,
        error_code: "INVALID_TRIP_STATE",
        reason: "Trip already started — use post-start cancellation.",
      };
    }
    if (isTerminalTripLifecycleStatus(ctx.status) && status !== "searching_new_driver") {
      return {
        ...base,
        allowed: true,
        idempotent: true,
        error_code: "ACTION_ALREADY_COMPLETED",
        resulting_status: status,
        resulting_dispatch_status: dispatch,
      };
    }
    const effects = defaultSideEffects();
    effects.assignment = "exclude_and_clear";
    effects.waiting = "clear";
    effects.customer_live_location = "clear";
    effects.modification_allowed = true;
    effects.payment = "unchanged";
    effects.notify = ["customer", "admin"];
    return {
      ...base,
      allowed: true,
      current_state: state,
      next_state: "OFFERED",
      // Production Edge: status=searching_new_driver, dispatch_status=broadcasting.
      resulting_status: "searching_new_driver",
      resulting_dispatch_status: "broadcasting",
      side_effects: effects,
    };
  }

  // ── Driver cancel after start → terminal ───────────────────────
  if (action === "driver_cancel_after_start") {
    if (actor !== "driver" && actor !== "admin") {
      return { ...base, error_code: "UNAUTHORIZED_ACTOR" };
    }
    const assignErr = requireAssignedDriver(ctx, actor);
    if (assignErr) return { ...base, error_code: assignErr };
    if (!hasStarted(ctx)) {
      return {
        ...base,
        error_code: "INVALID_TRIP_STATE",
        reason: "Trip not started — use pre-start rematch cancel.",
      };
    }
    if (isTerminalTripLifecycleStatus(ctx.status)) {
      return {
        ...base,
        allowed: true,
        idempotent: true,
        error_code: "ACTION_ALREADY_COMPLETED",
        resulting_status: status,
        resulting_dispatch_status: dispatch || "cancelled",
      };
    }
    const effects = defaultSideEffects();
    effects.assignment = "clear";
    effects.customer_live_location = "clear";
    effects.modification_allowed = false;
    effects.payment = "cancel_auth";
    effects.notify = ["customer", "admin"];
    return {
      ...base,
      allowed: true,
      next_state: "CANCELLED",
      resulting_status: "cancelled",
      resulting_dispatch_status: "cancelled",
      side_effects: effects,
    };
  }

  // ── Customer / admin terminal cancel ───────────────────────────
  if (action === "customer_cancel" || action === "admin_cancel") {
    if (action === "customer_cancel" && actor !== "customer" && actor !== "service_role") {
      return { ...base, error_code: "UNAUTHORIZED_ACTOR" };
    }
    if (action === "admin_cancel" && actor !== "admin" && actor !== "service_role") {
      return { ...base, error_code: "UNAUTHORIZED_ACTOR" };
    }
    if (isTerminalTripLifecycleStatus(ctx.status)) {
      return {
        ...base,
        allowed: true,
        idempotent: true,
        error_code: "ACTION_ALREADY_COMPLETED",
        resulting_status: status,
        resulting_dispatch_status: dispatch || "cancelled",
      };
    }
    const effects = defaultSideEffects();
    effects.assignment = "clear";
    effects.queue = "cancel_queued";
    effects.customer_live_location = "clear";
    effects.modification_allowed = false;
    effects.payment = "cancel_auth";
    effects.notify = ["customer", "driver", "admin"];
    return {
      ...base,
      allowed: true,
      next_state: "CANCELLED",
      resulting_status: "cancelled",
      resulting_dispatch_status: "cancelled",
      side_effects: effects,
    };
  }

  // ── Legacy cancel_trip mapping (prefer specialised actions) ────
  if (action === "cancel_trip") {
    if (actor === "driver" && !hasStarted(ctx)) {
      return resolveLifecycleTransition("driver_cancel_before_start", actor, ctx, stops);
    }
    if (actor === "driver" && hasStarted(ctx)) {
      return resolveLifecycleTransition("driver_cancel_after_start", actor, ctx, stops);
    }
    if (actor === "customer") {
      return resolveLifecycleTransition("customer_cancel", actor, ctx, stops);
    }
    if (actor === "admin") {
      return resolveLifecycleTransition("admin_cancel", actor, ctx, stops);
    }
  }

  // ── Queued cancel / promote ────────────────────────────────────
  if (action === "cancel_queued_trip") {
    if (actor !== "driver" && actor !== "admin" && actor !== "service_role") {
      return { ...base, error_code: "UNAUTHORIZED_ACTOR" };
    }
    if (!isQueued(ctx)) {
      return {
        ...base,
        error_code: "QUEUED_TRIP_NOT_CANCELLABLE",
        reason: "Trip is not in queued stacked state.",
      };
    }
    const effects = defaultSideEffects();
    effects.assignment = "exclude_and_clear";
    effects.queue = "cancel_queued";
    effects.notify = ["customer", "admin"];
    effects.modification_allowed = true;
    return {
      ...base,
      allowed: true,
      next_state: "OFFERED",
      resulting_status: "searching_new_driver",
      resulting_dispatch_status: "stacked_rebroadcasting",
      side_effects: effects,
    };
  }

  if (action === "promote_queued_trip") {
    if (actor !== "system" && actor !== "service_role" && actor !== "driver") {
      return { ...base, error_code: "UNAUTHORIZED_ACTOR" };
    }
    if (!isQueued(ctx)) {
      return {
        ...base,
        error_code: "INVALID_QUEUE_STATE",
        reason: "Only a queued trip can be promoted.",
      };
    }
    if (isTerminalTripLifecycleStatus(ctx.status)) {
      return {
        ...base,
        error_code: "INVALID_TRIP_STATE",
        reason: "Cannot promote a terminal queued trip.",
      };
    }
    const effects = defaultSideEffects();
    effects.assignment = "set_assigned";
    effects.queue = "promote_to_active";
    effects.customer_live_location = "allow_if_policy";
    effects.notify = ["customer", "driver", "admin"];
    return {
      ...base,
      allowed: true,
      next_state: "DRIVER_ASSIGNED",
      resulting_status: "driver_assigned",
      resulting_dispatch_status: "assigned",
      side_effects: effects,
    };
  }

  // ── Modifications ──────────────────────────────────────────────
  if (action === "pre_trip_modification") {
    if (hasStarted(ctx) || isTerminalTripLifecycleStatus(ctx.status)) {
      return {
        ...base,
        error_code: "MODIFICATION_NOT_ALLOWED",
        reason: "Pre-trip modification not allowed in current state.",
      };
    }
    return {
      ...base,
      allowed: true,
      current_state: state,
      next_state: state,
      side_effects: {
        ...defaultSideEffects(),
        notify: ["driver", "customer", "admin"],
      },
    };
  }

  if (action === "in_trip_modification") {
    if (!hasStarted(ctx) || isTerminalTripLifecycleStatus(ctx.status)) {
      return {
        ...base,
        error_code: "MODIFICATION_NOT_ALLOWED",
        reason: "In-trip modification requires in-progress trip.",
      };
    }
    return {
      ...base,
      allowed: true,
      current_state: state,
      next_state: state,
      side_effects: {
        ...defaultSideEffects(),
        notify: ["driver", "customer", "admin"],
      },
    };
  }

  // ── Payment / settlement (idempotent gates only) ───────────────
  if (action === "payment_capture") {
    if (status !== "completed" && status !== "no_show") {
      return {
        ...base,
        error_code: "INVALID_TRIP_STATE",
        reason: "Capture requires completed or payable no-show trip.",
      };
    }
    const pay = normalizeTripLifecycleDbStatus(ctx.payment?.payment_status);
    if (pay === "captured" || pay === "succeeded") {
      return {
        ...base,
        allowed: true,
        idempotent: true,
        error_code: "ACTION_ALREADY_COMPLETED",
        resulting_status: status,
      };
    }
    return {
      ...base,
      allowed: true,
      side_effects: {
        ...defaultSideEffects(),
        payment: "capture_pending",
        modification_allowed: false,
        notify: ["admin"],
      },
    };
  }

  if (action === "settlement_complete") {
    if (status !== "completed" && status !== "no_show") {
      return { ...base, error_code: "INVALID_TRIP_STATE" };
    }
    return {
      ...base,
      allowed: true,
      side_effects: {
        ...defaultSideEffects(),
        payment: "settle",
        modification_allowed: false,
        notify: ["admin"],
      },
    };
  }

  // Fallback: physical validator
  const physicalAction = mapToPhysicalAction(action);
  if (physicalAction) {
    const physical = validateTripActionTransition(physicalAction, ctx, stops);
    return {
      ...base,
      ...physical,
      error_code: physical.allowed
        ? undefined
        : physical.idempotent
        ? "ACTION_ALREADY_COMPLETED"
        : "INVALID_TRIP_STATE",
    };
  }

  return {
    ...base,
    error_code: "INVALID_TRIP_STATE",
    reason: `Unsupported lifecycle action: ${action}`,
  };
}

/** Map stop-workflow / cancel-trip action names → matrix actions. */
export function mapEdgeActionToMatrixAction(
  edgeAction: string,
  opts?: { tripStarted?: boolean; isNoShow?: boolean; isQueued?: boolean },
): MatrixLifecycleAction | null {
  switch (edgeAction) {
    case "arrive_pickup":
      return "arrive_pickup";
    case "start_trip":
      return "start_trip";
    case "arrive_stop":
      return "arrive_stop";
    case "drive_to_next":
    case "next_stop":
      return "drive_to_next";
    case "complete_trip":
      return "complete_trip";
    case "cancel_queued_stacked":
      return "cancel_queued_trip";
    case "driver_cancel":
      return opts?.tripStarted
        ? "driver_cancel_after_start"
        : "driver_cancel_before_start";
    case "passenger_no_show":
    case "no_show":
      return "passenger_no_show";
    case "customer_cancel":
      return "customer_cancel";
    case "admin_cancel":
      return "admin_cancel";
    case "promote_stacked_trip":
    case "promote_queued_trip":
      return "promote_queued_trip";
    default:
      if (opts?.isNoShow) return "passenger_no_show";
      if (opts?.isQueued && edgeAction.includes("cancel")) return "cancel_queued_trip";
      return null;
  }
}

/**
 * Human-readable matrix rows for docs / Admin alignment.
 * Executable truth remains resolveLifecycleTransition.
 */
export const LIFECYCLE_MATRIX_DOC_ROWS: ReadonlyArray<{
  action: MatrixLifecycleAction;
  actor: LifecycleActor;
  from_status: string;
  to_status: string;
  to_dispatch: string;
  notes: string;
}> = [
  {
    action: "accept_offer",
    actor: "driver",
    from_status: "offered/searching",
    to_status: "driver_assigned",
    to_dispatch: "assigned",
    notes: "Matches accept_ride_offer SSOT — does not start trip",
  },
  {
    action: "accept_stacked",
    actor: "driver",
    from_status: "offered (while Trip A active)",
    to_status: "queued",
    to_dispatch: "assigned",
    notes: "Queues; does not replace active trip",
  },
  {
    action: "arrive_pickup",
    actor: "driver",
    from_status: "driver_assigned/en_route",
    to_status: "arrived_at_pickup",
    to_dispatch: "assigned",
    notes: "Starts free waiting; idempotent",
  },
  {
    action: "start_trip",
    actor: "driver",
    from_status: "arrived_at_pickup/pickup_waiting",
    to_status: "in_progress",
    to_dispatch: "assigned",
    notes: "Requires arrival; hides customer live marker",
  },
  {
    action: "complete_trip",
    actor: "driver",
    from_status: "in_progress",
    to_status: "completed",
    to_dispatch: "completed",
    notes: "Capture pending + promote queued",
  },
  {
    action: "passenger_no_show",
    actor: "driver",
    from_status: "arrived_at_pickup/pickup_waiting",
    to_status: "no_show",
    to_dispatch: "no_show",
    notes: "Clears assignment; Completed history",
  },
  {
    action: "driver_cancel_before_start",
    actor: "driver",
    from_status: "driver_assigned…arrived",
    to_status: "searching_new_driver",
    to_dispatch: "broadcasting",
    notes: "Rematch — customer trip survives; matches driver-cancel-before-pickup Edge",
  },
  {
    action: "driver_cancel_after_start",
    actor: "driver",
    from_status: "in_progress",
    to_status: "cancelled",
    to_dispatch: "cancelled",
    notes: "Terminal incident policy",
  },
  {
    action: "customer_cancel",
    actor: "customer",
    from_status: "non-terminal",
    to_status: "cancelled",
    to_dispatch: "cancelled",
    notes: "Clears offers/assignments",
  },
  {
    action: "admin_cancel",
    actor: "admin",
    from_status: "non-terminal",
    to_status: "cancelled",
    to_dispatch: "cancelled",
    notes: "Audit actor + reason",
  },
  {
    action: "cancel_queued_trip",
    actor: "driver",
    from_status: "queued",
    to_status: "searching_new_driver",
    to_dispatch: "stacked_rebroadcasting",
    notes: "Active Trip A unchanged",
  },
  {
    action: "promote_queued_trip",
    actor: "system",
    from_status: "queued",
    to_status: "driver_assigned",
    to_dispatch: "assigned",
    notes: "Exactly one promotion after A completes",
  },
];
