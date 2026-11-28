/** Offline test/audit-only helpers; not part of Edge uploads. */
import { resolveFleetMaxPickupDistanceMiles } from "../../../functions/_shared/fleetMaxPickupDistanceSSOT.ts";


/** Read fleet max miles from a global_dispatch_settings-shaped row (or null). */
export function fleetMaxPickupMilesFromDispatchRow(
  row: Record<string, unknown> | null | undefined,
): number {
  return resolveFleetMaxPickupDistanceMiles(row?.fleet_max_pickup_distance_miles);
}

export * from "../../../functions/_shared/fleetMaxPickupDistanceSSOT.ts";
export * from "../../../../shared/edgePresentation/fleetMaxPickupDistanceSSOT.ts";
