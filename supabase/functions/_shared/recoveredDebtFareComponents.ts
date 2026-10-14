/**
 * Recovery bookings: the capture also collected an older customer receivable.
 * trips.capture_amount_pence then includes that debt, so any settlement
 * recomputed from the trip row must use the frozen trip fare component
 * instead. Recovered debt never enters driver earnings or commissionable fare.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import { recoveredDebtTripFareComponentPence } from "./tripSettlement.ts";

export type RecoveredDebtFareComponents = {
  /** trip_id → frozen trip fare component (pence) for trips whose capture included debt. */
  fareByTrip: Map<string, number>;
  /** Debt folded in but no fare component — callers must fail closed. */
  ambiguousTripIds: Set<string>;
};

export async function loadRecoveredDebtFareComponents(
  supabase: SupabaseClient,
  tripIds: readonly string[],
): Promise<RecoveredDebtFareComponents> {
  const ids = [...new Set(tripIds.map((t) => String(t ?? "").trim()).filter(Boolean))];
  const result: RecoveredDebtFareComponents = { fareByTrip: new Map(), ambiguousTripIds: new Set() };
  if (ids.length === 0) return result;

  const { data, error } = await supabase
    .from("payment_sessions")
    .select("trip_id, trip_fare_component_pence, receivable_component_pence")
    .in("trip_id", ids)
    .gt("receivable_component_pence", 0);
  if (error) {
    throw new Error(`recovered debt fare components unavailable: ${error.message}`);
  }

  for (const row of data ?? []) {
    const tripId = String((row as { trip_id?: unknown }).trip_id ?? "");
    const fare = recoveredDebtTripFareComponentPence(
      row as { trip_fare_component_pence?: number | null; receivable_component_pence?: number | null },
    );
    if (!tripId || fare == null) continue;
    if (Number.isNaN(fare)) {
      result.ambiguousTripIds.add(tripId);
    } else {
      result.fareByTrip.set(tripId, fare);
    }
  }
  return result;
}

/** Returns the trip row with the frozen fare component attached when its capture included debt. */
export function withRecoveredDebtFareComponent<T extends Record<string, unknown>>(
  trip: T,
  components: RecoveredDebtFareComponents,
): T {
  const fare = components.fareByTrip.get(String(trip.id ?? ""));
  return fare == null ? trip : { ...trip, trip_fare_component_pence: fare };
}
