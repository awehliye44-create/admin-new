/**
 * Modification fare delta SSOT (preview === apply).
 *
 * fare_delta   = new_remaining_route_fare - old_remaining_route_fare
 * new_fare     = current_confirmed_fare + fare_delta
 *
 * Both remaining-route fares must be priced from the SAME frozen origin
 * (see modificationRouteOrigin.ts). The delta may be negative when the new
 * remaining route is cheaper; a decrease needs no incremental authorisation,
 * the existing hold simply stays higher until capture.
 */

export type ModificationFareDeltaInput = {
  currentConfirmedFarePence: number;
  oldRemainingRouteFarePence: number;
  newRemainingRouteFarePence: number;
};

export type ModificationFareDelta = {
  fareDeltaPence: number;
  newFarePence: number;
  /** Incremental authorisation is only ever needed when the fare goes up. */
  paymentRequired: boolean;
};

export function computeModificationFareDelta(
  input: ModificationFareDeltaInput,
): ModificationFareDelta {
  const fareDeltaPence = Math.round(input.newRemainingRouteFarePence) -
    Math.round(input.oldRemainingRouteFarePence);
  const newFarePence = Math.max(
    1,
    Math.round(input.currentConfirmedFarePence) + fareDeltaPence,
  );

  return {
    fareDeltaPence,
    newFarePence,
    paymentRequired: fareDeltaPence > 0,
  };
}
