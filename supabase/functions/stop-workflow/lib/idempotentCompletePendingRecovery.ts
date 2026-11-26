/**
 * P6 — idempotent `complete_trip` PENDING recovery (non-atomic hardening).
 *
 * When a repeated Complete finds the trip already `completed`, the first Complete
 * may have written status=completed and then died before TRIP_EARNING_PENDING was
 * posted (the completion path is NOT atomic — `complete_trip_atomic` is still not
 * called). Heal that single gap, and nothing else:
 *
 *  - only PLATFORM_COLLECTED trips with a driver and driver_net_pence > 0
 *  - only while capture has NOT confirmed (awaiting-capture payment statuses)
 *  - never when ANY TRIP_EARNING_NET exists (trip already settled — never invent PENDING)
 *  - never when PENDING already exists (creditTripEarningPending is idempotent anyway)
 *  - never for captured / paid / succeeded trips (no historical PENDING for settled trips)
 *
 * Errors are returned, never thrown: the Driver must never be stuck on Complete.
 */

import { readTripEarningNetLedgerState } from "../../_shared/tripEarningNetLedgerReadback.ts";
import {
  creditTripEarningPending,
  pendingEntitlementAmountPence,
  TRIP_EARNING_PENDING_TYPE,
} from "../../_shared/tripEarningPendingSSOT.ts";
import { PENDING_RECOVERY_AWAITING_CAPTURE_STATUSES } from "../../_shared/missingTripEarningPendingRecoverySSOT.ts";

// deno-lint-ignore no-explicit-any
type SupabaseLike = { from: (table: string) => any };

export type IdempotentPendingRecoveryOutcome =
  | "inserted"
  | "already_present"
  | "ten_exists"
  | "not_eligible"
  | "no_entitlement"
  | "failed";

export type IdempotentPendingRecoveryDeps = {
  readTen: (supabase: SupabaseLike, tripId: string) => Promise<{ count: number }>;
  creditPending: typeof creditTripEarningPending;
};

const DEFAULT_DEPS: IdempotentPendingRecoveryDeps = {
  readTen: readTripEarningNetLedgerState,
  creditPending: creditTripEarningPending,
};

export async function recoverMissingPendingOnIdempotentComplete(
  supabase: SupabaseLike,
  tripId: string,
  deps: IdempotentPendingRecoveryDeps = DEFAULT_DEPS,
): Promise<{ outcome: IdempotentPendingRecoveryOutcome; reason?: string; amountPence?: number }> {
  try {
    const { data: trip, error } = await supabase
      .from("trips")
      .select(
        "id, status, driver_id, confirmed_driver_id, financial_model, payment_status, driver_net_pence, airport_charge_pence",
      )
      .eq("id", tripId)
      .maybeSingle();
    if (error || !trip) return { outcome: "failed", reason: error?.message ?? "trip_not_found" };

    if (String(trip.status ?? "").toLowerCase() !== "completed") {
      return { outcome: "not_eligible", reason: "not_completed" };
    }
    if (String(trip.financial_model ?? "").trim().toUpperCase() !== "PLATFORM_COLLECTED") {
      return { outcome: "not_eligible", reason: "not_platform_collected" };
    }
    const driverId = String(trip.confirmed_driver_id ?? trip.driver_id ?? "").trim();
    if (!driverId) return { outcome: "not_eligible", reason: "no_driver" };

    const pay = String(trip.payment_status ?? "").toLowerCase();
    const awaitingCapture = pay === ""
      || (PENDING_RECOVERY_AWAITING_CAPTURE_STATUSES as readonly string[]).includes(pay);
    if (!awaitingCapture) return { outcome: "not_eligible", reason: "capture_settled_or_terminal" };

    if (!(Number(trip.driver_net_pence) > 0)) {
      return { outcome: "no_entitlement", reason: "driver_net_not_positive" };
    }

    // Never invent PENDING once TEN exists for the trip.
    const ten = await deps.readTen(supabase, tripId);
    if (ten.count > 0) return { outcome: "ten_exists" };

    const { data: pending } = await supabase
      .from("driver_wallet_ledger")
      .select("id")
      .eq("related_trip_id", tripId)
      .eq("type", TRIP_EARNING_PENDING_TYPE)
      .maybeSingle();
    if (pending) return { outcome: "already_present" };

    const amountPence = pendingEntitlementAmountPence({
      driverNetPence: trip.driver_net_pence,
      airportChargePence: trip.airport_charge_pence,
    });
    if (amountPence <= 0) return { outcome: "no_entitlement", reason: "amount_non_positive" };

    const credited = await deps.creditPending(supabase as never, {
      tripId,
      driverId,
      amountPence,
    });
    if (!credited.ok) return { outcome: "failed", reason: credited.reason, amountPence };
    return { outcome: credited.inserted ? "inserted" : "already_present", amountPence };
  } catch (err) {
    return { outcome: "failed", reason: err instanceof Error ? err.message : String(err) };
  }
}
