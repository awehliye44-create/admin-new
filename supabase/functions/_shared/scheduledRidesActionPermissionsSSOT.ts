/**
 * Phase 3 final — map admin-scheduled-ride-action names → role_action_permissions keys.
 * Keep in sync with shared/rolesPermissionsSSOT.ts SCHEDULED_RIDES_EDGE_ACTION_PERMISSION.
 */

export const SCHEDULED_RIDES_EDGE_ACTION_PERMISSION = {
  make_available_now: "scheduled_rides.make_available",
  make_available_at: "scheduled_rides.make_available",
  assign_at: "scheduled_rides.assign",
  assign_now: "scheduled_rides.assign",
  broadcast_now: "scheduled_rides.broadcast",
  broadcast_at: "scheduled_rides.broadcast",
  hold_exceptional: "scheduled_rides.hold",
  cancel_pending_release: "scheduled_rides.cancel_pending",
  cancel_ride: "scheduled_rides.cancel_ride",
} as const;

export type ScheduledRideEdgeAction = keyof typeof SCHEDULED_RIDES_EDGE_ACTION_PERMISSION;

export function permissionKeyForScheduledRideAction(
  action: string,
): string | null {
  const key = SCHEDULED_RIDES_EDGE_ACTION_PERMISSION[
    action as ScheduledRideEdgeAction
  ];
  return key ?? null;
}
