/**
 * Caller authorisation for late-cancellation-check.
 *
 * The function cancels a trip, stamps fees and can start terminal fee
 * settlement, so the caller must be one of:
 *   - an internal service-role caller,
 *   - an active staff member allowed to cancel trips,
 *   - the passenger who owns the trip.
 * The recorded `cancelled_by` comes from the verified caller, never from the body,
 * except for service-role callers who act on behalf of a named actor.
 */

export const LATE_CANCEL_STAFF_ROLES = new Set(["super_admin", "admin", "operator"]);

const SERVICE_ROLE_CANCELLED_BY = new Set(["passenger", "rider", "customer", "admin", "system"]);

export type LateCancelCaller =
  | { kind: "service_role" }
  | { kind: "staff"; userId: string; role: string; isActive: boolean }
  | { kind: "user"; userId: string; customerIds: string[] };

export type LateCancelAuthDecision =
  | { ok: true; cancelledBy: string; actorUserId: string | null; callerKind: LateCancelCaller["kind"] }
  | { ok: false; status: 403; code: "FORBIDDEN" | "NOT_TRIP_PASSENGER" | "STAFF_INACTIVE" | "INVALID_CANCELLED_BY" };

export function authoriseLateCancellationCaller(args: {
  caller: LateCancelCaller;
  tripPassengerId: string | null | undefined;
  requestedCancelledBy?: unknown;
}): LateCancelAuthDecision {
  const { caller } = args;

  if (caller.kind === "service_role") {
    const requested = typeof args.requestedCancelledBy === "string"
      ? args.requestedCancelledBy.trim().toLowerCase()
      : "";
    if (requested === "") return { ok: true, cancelledBy: "passenger", actorUserId: null, callerKind: "service_role" };
    if (!SERVICE_ROLE_CANCELLED_BY.has(requested)) {
      return { ok: false, status: 403, code: "INVALID_CANCELLED_BY" };
    }
    return { ok: true, cancelledBy: requested, actorUserId: null, callerKind: "service_role" };
  }

  if (caller.kind === "staff") {
    if (!caller.isActive) return { ok: false, status: 403, code: "STAFF_INACTIVE" };
    if (!LATE_CANCEL_STAFF_ROLES.has(caller.role)) return { ok: false, status: 403, code: "FORBIDDEN" };
    return { ok: true, cancelledBy: "admin", actorUserId: caller.userId, callerKind: "staff" };
  }

  const passengerId = typeof args.tripPassengerId === "string" ? args.tripPassengerId : null;
  if (!passengerId || !caller.customerIds.includes(passengerId)) {
    return { ok: false, status: 403, code: "NOT_TRIP_PASSENGER" };
  }
  return { ok: true, cancelledBy: "passenger", actorUserId: caller.userId, callerKind: "user" };
}
