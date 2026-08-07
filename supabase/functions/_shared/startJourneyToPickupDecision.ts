/**
 * Pure decision helper for stop-workflow start_journey_to_pickup.
 * On-demand and scheduled share the same transition; airport logging is separate.
 */

export const CANONICAL_EN_ROUTE_TO_PICKUP = "en_route_to_pickup";

export const EN_ROUTE_TO_PICKUP_STATUSES = new Set([
  "en_route_to_pickup",
  "enroute_to_pickup",
  "driver_en_route",
  "en_route",
  "driver_arriving",
]);

export const CAN_START_JOURNEY_FROM_STATUSES = new Set([
  "driver_assigned",
  "assigned",
  "accepted",
  "confirmed",
  "driver_confirmed",
  "queued",
]);

export type StartJourneyDecision =
  | { kind: "idempotent"; status: string }
  | { kind: "transition"; from: string; to: typeof CANONICAL_EN_ROUTE_TO_PICKUP }
  | { kind: "reject"; code: string; message: string };

export function resolveStartJourneyToPickupDecision(input: {
  status: string | null | undefined;
  arrivedAt?: string | null;
  isArrivedStatus?: boolean;
}): StartJourneyDecision {
  const currentStatus = String(input.status || "").toLowerCase();
  if (input.arrivedAt || input.isArrivedStatus) {
    return {
      kind: "reject",
      code: "invalid_status",
      message: "Cannot start journey after arriving at pickup",
    };
  }
  if (EN_ROUTE_TO_PICKUP_STATUSES.has(currentStatus)) {
    return { kind: "idempotent", status: currentStatus };
  }
  if (!CAN_START_JOURNEY_FROM_STATUSES.has(currentStatus)) {
    return {
      kind: "reject",
      code: "invalid_status",
      message: `Cannot start journey to pickup from status ${input.status}`,
    };
  }
  return {
    kind: "transition",
    from: currentStatus,
    to: CANONICAL_EN_ROUTE_TO_PICKUP,
  };
}
