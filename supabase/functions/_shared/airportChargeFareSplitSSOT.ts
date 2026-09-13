/**
 * Airport charge fare split — draft SSOT.
 *
 * Airport is customer-payable and non-commissionable pass-through.
 * The amount comes from the route-pricing quote. The commission rate
 * comes from the active wave/tier helper. Neither is a constant here.
 *
 * Before: commissionable = folded payable (ride + airport), rate applied to that total.
 * After:  commissionable = customer payable − airport − other non-commissionable
 *         driver_net = commissionable − commission + airport + other pass-through
 *
 * Does not write ledgers, capture, or completed-trip money.
 */

export type WaveCommissionRate = {
  /** Already resolved by resolveWaveCommission / resolve_wave_commission_percent. */
  effectivePercent: number;
};

export type RouteExtraItem = {
  type: "airport";
  label: string;
  amount_pence: number;
};

export type FareSplit = {
  airport_charge_pence: number;
  commissionable_fare_pence: number;
};

export type DriverNetSplit = {
  commissionablePence: number;
  commissionPence: number;
  driverNetPence: number;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function positiveInt(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

/** Named major fields on the quote (`tripFare`, `airportCharge`) are pounds. */
function majorToPence(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * 100);
}

export function resolveQuoteAirportChargePence(
  source: Record<string, unknown> | null | undefined,
): number {
  const row = asRecord(source);
  if (!row) return 0;
  const explicit = positiveInt(row.airport_charge_pence ?? row.airportChargePence);
  if (explicit != null) return explicit;
  const major = majorToPence(row.airportCharge ?? row.airport_charge);
  if (major > 0) return major;
  const pickup = Number(row.airport_pickup_fee ?? row.airportPickupFee ?? 0);
  const dropoff = Number(row.airport_dropoff_fee ?? row.airportDropoffFee ?? 0);
  if ((pickup > 0 || dropoff > 0) && Number.isFinite(pickup) && Number.isFinite(dropoff)) {
    return Math.round((pickup + dropoff) * 100);
  }
  return 0;
}

export function resolveQuoteRideFarePence(
  source: Record<string, unknown> | null | undefined,
): number {
  const row = asRecord(source);
  if (!row) return 0;
  const explicit = positiveInt(row.trip_fare_pence ?? row.tripFarePence);
  if (explicit != null) return explicit;
  return majorToPence(row.tripFare ?? row.trip_fare);
}

export function resolveQuoteFinalFarePence(
  source: Record<string, unknown> | null | undefined,
): number {
  const row = asRecord(source);
  if (!row) return 0;
  const explicit = positiveInt(
    row.final_fare_pence ?? row.total_fare_pence ?? row.finalFarePence ?? row.totalFarePence,
  );
  if (explicit != null) return explicit;
  return majorToPence(row.finalFare ?? row.totalFare ?? row.final_fare ?? row.total_fare);
}

/**
 * Column wins when already persisted. Otherwise the quote breakdown.
 * Never invents an airport amount.
 */
export function resolvePersistedAirportChargePence(trip: {
  airport_charge_pence?: number | null;
  fare_breakdown?: unknown;
  fare_snapshot_json?: unknown;
}): number {
  const column = positiveInt(trip.airport_charge_pence);
  if (column != null) return column;
  return resolveQuoteAirportChargePence(asRecord(trip.fare_breakdown))
    || resolveQuoteAirportChargePence(asRecord(trip.fare_snapshot_json));
}

/**
 * Persist split from the quote. Payable stays the customer total (caller does not change it).
 * Returns null when the quote has no ride/airport split to persist.
 */
export function bookingFareSplitFromQuote(input: {
  payablePence: number;
  fareBreakdown: Record<string, unknown> | null | undefined;
}): FareSplit | null {
  const breakdown = asRecord(input.fareBreakdown);
  if (!breakdown) return null;
  const hasAirport = "airportCharge" in breakdown
    || "airport_charge" in breakdown
    || "airport_charge_pence" in breakdown
    || "airportChargePence" in breakdown;
  const hasRide = "tripFare" in breakdown
    || "trip_fare" in breakdown
    || "trip_fare_pence" in breakdown
    || "tripFarePence" in breakdown;
  if (!hasAirport && !hasRide) return null;

  const airport = resolveQuoteAirportChargePence(breakdown);
  const ride = resolveQuoteRideFarePence(breakdown);
  const payable = Math.max(0, Math.round(Number(input.payablePence) || 0));
  const commissionable = ride > 0 ? ride : Math.max(0, payable - airport);
  return {
    airport_charge_pence: airport,
    commissionable_fare_pence: commissionable,
  };
}

/** Rate is whatever the active wave/tier helper already resolved. No default rate. */
export function commissionPercentFromActiveWave(wave: WaveCommissionRate): number {
  const pct = Number(wave?.effectivePercent);
  if (!Number.isFinite(pct) || pct < 0) return 0;
  return Math.min(100, pct);
}

/**
 * commissionable = gross − airport − other_non_commissionable
 * driver_net = commissionable − commission + airport + other pass-through
 */
export function driverNetFromCustomerTotal(input: {
  customerPence: number;
  airportPence: number;
  otherPassThroughPence?: number;
  commissionPercent: number;
}): DriverNetSplit {
  const customer = Math.max(0, Math.round(Number(input.customerPence) || 0));
  const airport = Math.max(0, Math.round(Number(input.airportPence) || 0));
  const other = Math.max(0, Math.round(Number(input.otherPassThroughPence) || 0));
  const pct = Math.min(100, Math.max(0, Number(input.commissionPercent) || 0));
  const commissionablePence = Math.max(0, customer - airport - other);
  const commissionPence = Math.round((commissionablePence * pct) / 100);
  const driverNetPence = Math.max(0, commissionablePence - commissionPence) + airport + other;
  return { commissionablePence, commissionPence, driverNetPence };
}

export function driverNetFromActiveWave(input: {
  customerPence: number;
  airportPence: number;
  otherPassThroughPence?: number;
  wave: WaveCommissionRate;
}): DriverNetSplit {
  return driverNetFromCustomerTotal({
    customerPence: input.customerPence,
    airportPence: input.airportPence,
    otherPassThroughPence: input.otherPassThroughPence,
    commissionPercent: commissionPercentFromActiveWave(input.wave),
  });
}

export function buildAirportRouteExtraItems(airportPence: number): RouteExtraItem[] {
  const amount = Math.max(0, Math.round(Number(airportPence) || 0));
  if (amount <= 0) return [];
  return [{ type: "airport", label: "Airport", amount_pence: amount }];
}

/**
 * True when the locked customer payable already contains the airport charge.
 * A ride-only payable plus a separate airport column is not "already included".
 *
 * `extraAlreadyInPayablePence` is a later change already folded into the locked
 * payable (modification, or waiting only when the caller has proved it is inside).
 * Do not pass a waiting column that completion still adds on top.
 */
export function airportAlreadyInsidePayable(input: {
  payablePence: number;
  airportPence: number;
  commissionableFarePence?: number | null;
  quoteRideFarePence?: number | null;
  quoteFinalFarePence?: number | null;
  extraAlreadyInPayablePence?: number | null;
}): boolean {
  const payable = Math.max(0, Math.round(Number(input.payablePence) || 0));
  const airport = Math.max(0, Math.round(Number(input.airportPence) || 0));
  if (airport <= 0 || payable <= 0) return false;
  const extras = Math.max(0, Math.round(Number(input.extraAlreadyInPayablePence) || 0));

  const commissionable = Math.max(0, Math.round(Number(input.commissionableFarePence) || 0));
  if (commissionable > 0 && payable === commissionable + airport + extras) return true;

  const ride = Math.max(0, Math.round(Number(input.quoteRideFarePence) || 0));
  if (ride > 0 && payable === ride + airport + extras) return true;

  const quotedFinal = Math.max(0, Math.round(Number(input.quoteFinalFarePence) || 0));
  return ride > 0 && quotedFinal === ride + airport && payable === quotedFinal + extras;
}

export type FareEnrichDispatchDecision = {
  allowDispatch: boolean;
  /** Existing auto-dispatch lock. Does not cancel the trip or touch payments. */
  holdBroadcast: boolean;
  reason: "airport_absent" | "airport_persisted" | "airport_persist_failed";
};

/**
 * Airport or route pass-through > 0 requires a confirmed column write before
 * offer insert. A zero quote keeps today's fail-open dispatch.
 */
export function decideDispatchAfterFareEnrich(input: {
  quoteAirportPence: number;
  persistedAirportPence: number | null;
  updateFailed: boolean;
}): FareEnrichDispatchDecision {
  const required = Math.max(0, Math.round(Number(input.quoteAirportPence) || 0));
  if (required <= 0) {
    return { allowDispatch: true, holdBroadcast: false, reason: "airport_absent" };
  }
  const persisted = input.persistedAirportPence == null
    ? null
    : Math.round(Number(input.persistedAirportPence));
  if (!input.updateFailed && persisted === required) {
    return { allowDispatch: true, holdBroadcast: false, reason: "airport_persisted" };
  }
  return { allowDispatch: false, holdBroadcast: true, reason: "airport_persist_failed" };
}

function annotatePresetNets(
  presets: unknown,
  airportPence: number,
  otherPassThroughPence: number,
  commissionPercent: number,
): unknown {
  if (!Array.isArray(presets)) return presets;
  return presets.map((item) => {
    if (!item || typeof item !== "object") return item;
    const row = item as Record<string, unknown>;
    const gross = Number(row.grossFarePence ?? row.gross_fare_pence ?? 0);
    if (!Number.isFinite(gross) || gross <= 0) return item;
    const split = driverNetFromCustomerTotal({
      customerPence: Math.round(gross),
      airportPence,
      otherPassThroughPence,
      commissionPercent,
    });
    return {
      ...row,
      driverNetPence: split.driverNetPence,
      driver_net_pence: split.driverNetPence,
      driver_net_fare_pence: split.driverNetPence,
      platform_commission_pence: split.commissionPence,
    };
  });
}

/**
 * Adds airport chip fields and recomputes server nets so airport is not commissioned.
 * Airport 0 leaves the snapshot and offered net untouched.
 */
export function stampOfferSnapshotAirportPassThrough(input: {
  snapshot: Record<string, unknown> | null | undefined;
  customerGrossPence: number;
  airportPence: number;
  otherPassThroughPence?: number;
  commissionPercent: number;
}): { snapshot: Record<string, unknown>; offeredDriverNetPence: number | null } {
  const base = input.snapshot ? { ...input.snapshot } : {};
  const airport = Math.max(0, Math.round(Number(input.airportPence) || 0));
  if (airport <= 0) {
    return { snapshot: base, offeredDriverNetPence: null };
  }

  const other = Math.max(0, Math.round(Number(input.otherPassThroughPence) || 0));
  const customer = Math.max(0, Math.round(Number(input.customerGrossPence) || 0));
  const split = driverNetFromCustomerTotal({
    customerPence: customer,
    airportPence: airport,
    otherPassThroughPence: other,
    commissionPercent: input.commissionPercent,
  });

  const extras = buildAirportRouteExtraItems(airport);
  const next: Record<string, unknown> = {
    ...base,
    airport_charge_pence: airport,
    airportChargePence: airport,
    route_extra_items: extras,
  };
  if (Array.isArray(base.preset_options)) {
    next.preset_options = annotatePresetNets(
      base.preset_options,
      airport,
      other,
      input.commissionPercent,
    );
  }

  // Wave net equal to the customer total is the existing display-net case.
  // Do not overwrite a trigger-stamped display net with the complete fare.
  if (customer <= 0 || split.driverNetPence !== customer) {
    next.driver_net_fare_pence = split.driverNetPence;
    next.driver_earnings_pence = split.driverNetPence;
    next.driver_net_preview_pence = split.driverNetPence;
    next.platform_commission_pence = split.commissionPence;
  }

  return { snapshot: next, offeredDriverNetPence: split.driverNetPence };
}
