/**
 * Release-candidate helper. Live wiring is auto-dispatch/index.ts
 * applyAlreadyOfferedAirportRestamp. Do not deploy this draft file.
 *
 * Do not use storedRound + 1. The insert trigger already advanced the round.
 * Rate is the offer's already-resolved effective_commission_percent.
 * Fail closed when a known airport charge cannot be represented.
 * Update only offer_snapshot and offered_driver_net_pence.
 */

import {
  decideAlreadyOfferedRestamp,
  type ExistingOfferForRestamp,
} from "../../functions/_shared/airportChargeFareSplitSSOT.ts";

export type AlreadyOfferedRestampCommand = {
  tripId: string;
  createOffer: false;
  notify: false;
  extendExpiry: false;
  action: "unchanged" | "restamp" | "fail_closed";
  reason: string;
  updates: Array<{
    id: string;
    offer_snapshot: Record<string, unknown>;
    offered_driver_net_pence: number;
  }>;
};

export function draftAlreadyOfferedRestamp(input: {
  tripId: string;
  nowMs: number;
  payablePence: number;
  airportPence: number;
  otherPassThroughPence?: number;
  offers: ExistingOfferForRestamp[];
  resolveWavePercent?: (wave: number) => number;
}): AlreadyOfferedRestampCommand {
  const airportPence = Math.max(0, Math.round(Number(input.airportPence) || 0));
  const payablePence = Math.max(0, Math.round(Number(input.payablePence) || 0));
  const other = Math.max(0, Math.round(Number(input.otherPassThroughPence) || 0));
  const commissionable = Math.max(0, payablePence - airportPence - other);
  const decision = decideAlreadyOfferedRestamp({
    nowMs: input.nowMs,
    trip: {
      airport_charge_pence: airportPence,
      commissionable_fare_pence: commissionable,
      final_fare_pence: payablePence,
      final_customer_fare_pence: payablePence,
      other_pass_through_charges_pence: other,
      fare_breakdown: airportPence > 0
        ? {
          airport_charge_pence: airportPence,
          trip_fare_pence: commissionable,
          final_fare_pence: payablePence,
        }
        : null,
    },
    offers: input.offers,
  });
  return {
    tripId: input.tripId,
    createOffer: decision.createOffer,
    notify: decision.notify,
    extendExpiry: decision.extendExpiry,
    action: decision.action,
    reason: decision.reason,
    updates: decision.updates.map((row) => ({
      id: row.id,
      offer_snapshot: row.offer_snapshot,
      offered_driver_net_pence: row.offered_driver_net_pence,
    })),
  };
}
