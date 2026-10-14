/**
 * Smallest read-back gate that can be applied to finalize-trip-and-capture v544.
 *
 * v544 already calculates capture, waiting, tip, cancellation and driver earnings
 * before it records a shortfall. This wrapper only decides whether the existing
 * receivable call runs. It does not change those amounts.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  recordReceivableAfterDeclinedIncrement,
  type ReceivableLifecycleResult,
} from "./customerReceivableLifecycle.ts";
import { makeReceivablePersistenceUnavailable } from "./customerReceivableSSOT.ts";
import { commitShortfallSessionMarker } from "./shortfallReceivableSafety.ts";

type ReceivableArgs = {
  customer_id?: string | null;
  source_trip_id: string;
  source_payment_session_id?: string | null;
  source_authorisation_id?: string | null;
  final_fare_pence?: number | null;
  captured_pence?: number | null;
  shortfall_pence?: number | null;
  currency?: string | null;
  pickup_waiting_charge_pence?: number | null;
  provider_state?: string | null;
};

type MarkerArgs = {
  sessionId?: string | null;
  providerOrderId?: string | null;
  tripId: string;
  shortfallPence: number;
  expectedFarePence?: number | null;
  capturedPence?: number | null;
  reason: string;
};

export async function recordReceivableAfterConfirmedMarker(
  supabase: SupabaseClient,
  args: { marker: MarkerArgs; receivable: ReceivableArgs },
  deps: {
    commit?: typeof commitShortfallSessionMarker;
    record?: typeof recordReceivableAfterDeclinedIncrement;
  } = {},
): Promise<ReceivableLifecycleResult<{ receivable_id: string; created: boolean; plan: unknown }>> {
  const commit = deps.commit ?? commitShortfallSessionMarker;
  const record = deps.record ?? recordReceivableAfterDeclinedIncrement;
  const committed = await commit(supabase, {
    sessionId: args.marker.sessionId,
    providerOrderId: args.marker.providerOrderId,
    tripId: args.marker.tripId,
    shortfallPence: args.marker.shortfallPence,
    expectedFarePence: args.marker.expectedFarePence,
    capturedPence: args.marker.capturedPence,
    reason: args.marker.reason,
  });
  if (!committed.committed) {
    return {
      ok: false,
      error: makeReceivablePersistenceUnavailable(committed.error ?? "marker_not_confirmed"),
      manual_review: true,
    };
  }
  return record(supabase, {
    ...args.receivable,
    source_payment_session_id: committed.sessionId ?? args.receivable.source_payment_session_id,
  });
}
