/**
 * Edge-side trip_state_violations writer for matrix/invariant blocks
 * that do not mutate trips (so the DB trigger never fires).
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

export type TripStateViolationLogInput = {
  tripId: string;
  tripCode?: string | null;
  oldStatus?: string | null;
  newStatus?: string | null;
  dispatchStatus?: string | null;
  driverId?: string | null;
  confirmedDriverId?: string | null;
  violationType: string;
  op?: string;
  requestPath?: string;
};

/**
 * Best-effort INSERT. Never throws — observe mode only.
 */
export async function logTripStateViolationFromEdge(
  supabase: SupabaseClient,
  input: TripStateViolationLogInput,
): Promise<void> {
  try {
    await supabase.from("trip_state_violations").insert({
      op: input.op ?? "EDGE_BLOCK",
      trip_id: input.tripId,
      trip_code: input.tripCode ?? null,
      old_status: input.oldStatus ?? null,
      new_status: input.newStatus ?? null,
      dispatch_status: input.dispatchStatus ?? null,
      driver_id: input.driverId ?? null,
      confirmed_driver_id: input.confirmedDriverId ?? null,
      violation_type: input.violationType,
      writer_application_name: "edge",
      writer_role: "service_role",
      request_path: input.requestPath ?? "stop-workflow",
    });
  } catch (error) {
    console.error("[logTripStateViolationFromEdge] failed", error);
  }
}
