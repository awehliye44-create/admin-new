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

export type ExistingOfferForRestamp = {
  id: string;
  status: string;
  is_stacked?: boolean | null;
  expires_at: string | null;
  dispatch_wave: number | null;
  /** Already resolved by the offer's wave helper. Not a default rate. */
  effective_commission_percent: number | null;
  offer_snapshot: Record<string, unknown> | null;
  offered_driver_net_pence: number | null;
};

export type PendingOfferRestampUpdate = {
  id: string;
  offer_snapshot: Record<string, unknown>;
  offered_driver_net_pence: number;
  /** Filter only. Never written. */
  match_dispatch_wave: number | null;
};

/**
 * When auto-dispatch finds an existing pending offer, restamp its calculated
 * snapshot instead of creating another offer. Updates snapshot fields and
 * offered_driver_net_pence only. Does not notify, extend expiry, or revive
 * revoked/accepted/expired rows. Airport 0 leaves the offer unchanged.
 *
 * Rate is the offer's already-resolved wave percent, else the caller-supplied
 * wave helper. Never a baked-in rate.
 */
export function planExistingPendingOfferRestamp(input: {
  nowMs: number;
  payablePence: number;
  airportPence: number;
  otherPassThroughPence?: number;
  offers: ExistingOfferForRestamp[];
  resolveWavePercent: (wave: number) => number;
  /** Live restamp must not invent a rate when the offer has none. */
  requireStoredCommissionPercent?: boolean;
}): {
  createOffer: false;
  notify: false;
  extendExpiry: false;
  updates: PendingOfferRestampUpdate[];
  skipped: Array<{ id: string; reason: string }>;
} {
  const airport = Math.max(0, Math.round(Number(input.airportPence) || 0));
  const payable = Math.max(0, Math.round(Number(input.payablePence) || 0));
  const other = Math.max(0, Math.round(Number(input.otherPassThroughPence) || 0));
  const updates: PendingOfferRestampUpdate[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];

  if (airport <= 0) {
    return {
      createOffer: false,
      notify: false,
      extendExpiry: false,
      updates,
      skipped: input.offers.map((offer) => ({ id: offer.id, reason: "airport_absent" })),
    };
  }

  for (const offer of input.offers) {
    if (offer.status !== "pending") {
      skipped.push({ id: offer.id, reason: "not_pending" });
      continue;
    }
    if (offer.is_stacked === true) {
      skipped.push({ id: offer.id, reason: "stacked" });
      continue;
    }
    const expiresMs = offer.expires_at ? Date.parse(offer.expires_at) : Number.NaN;
    if (!Number.isFinite(expiresMs) || expiresMs <= input.nowMs) {
      skipped.push({ id: offer.id, reason: "expired" });
      continue;
    }

    const snapshot = offer.offer_snapshot ? { ...offer.offer_snapshot } : {};
    const customer = Math.max(
      0,
      Math.round(Number(snapshot.baseFarePence ?? payable) || 0),
    );
    const storedRate = offer.effective_commission_percent;
    const hasStoredRate = storedRate != null && Number.isFinite(Number(storedRate));
    if (!hasStoredRate && input.requireStoredCommissionPercent) {
      skipped.push({ id: offer.id, reason: "rate_unresolved" });
      continue;
    }
    const commissionPercent = hasStoredRate
      ? commissionPercentFromActiveWave({ effectivePercent: Number(storedRate) })
      : commissionPercentFromActiveWave({
        effectivePercent: input.resolveWavePercent(
          Math.round(Number(offer.dispatch_wave) || 0) > 0
            ? Math.round(Number(offer.dispatch_wave))
            : 1,
        ),
      });

    const stamped = stampOfferSnapshotAirportPassThrough({
      snapshot,
      customerGrossPence: customer,
      airportPence: airport,
      otherPassThroughPence: other,
      commissionPercent,
    });
    if (stamped.offeredDriverNetPence == null) {
      skipped.push({ id: offer.id, reason: "no_net" });
      continue;
    }
    const already = offerSnapshotRepresentsAirport({
      snapshot,
      airportPence: airport,
      offeredDriverNetPence: offer.offered_driver_net_pence,
      expectedNetPence: stamped.offeredDriverNetPence,
    });
    if (already) {
      skipped.push({ id: offer.id, reason: "already_stamped" });
      continue;
    }
    if (!offerSnapshotRepresentsAirport({
      snapshot: stamped.snapshot,
      airportPence: airport,
      offeredDriverNetPence: stamped.offeredDriverNetPence,
      expectedNetPence: stamped.offeredDriverNetPence,
    })) {
      skipped.push({ id: offer.id, reason: "stamp_unrepresentable" });
      continue;
    }
    updates.push({
      id: offer.id,
      offer_snapshot: stamped.snapshot,
      offered_driver_net_pence: stamped.offeredDriverNetPence,
      match_dispatch_wave: offer.dispatch_wave,
    });
  }

  return {
    createOffer: false,
    notify: false,
    extendExpiry: false,
    updates,
    skipped,
  };
}

function offerSnapshotRepresentsAirport(input: {
  snapshot: Record<string, unknown>;
  airportPence: number;
  offeredDriverNetPence: number | null;
  expectedNetPence: number;
}): boolean {
  const extras = input.snapshot.route_extra_items;
  const chip = Array.isArray(extras)
    ? extras.find((item) => item && typeof item === "object" && (item as { type?: string }).type === "airport")
    : null;
  const chipAmount = chip && typeof chip === "object"
    ? Number((chip as { amount_pence?: unknown }).amount_pence)
    : Number.NaN;
  return input.offeredDriverNetPence === input.expectedNetPence
    && Number(input.snapshot.airport_charge_pence) === input.airportPence
    && chipAmount === input.airportPence;
}

export type PersistedAirportSplitAssessment =
  | {
    ok: true;
    reason: "airport_absent";
    airportPence: 0;
    payablePence: number;
  }
  | {
    ok: true;
    reason: "split_persisted";
    airportPence: number;
    payablePence: number;
    commissionablePence: number;
    otherPassThroughPence: number;
  }
  | {
    ok: false;
    reason: "airport_not_on_column" | "split_mismatch";
  };

function nonNegInt(value: unknown): number {
  const n = Math.round(Number(value) || 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * A known airport charge is representable only when the column matches the
 * quote and the payable already includes that amount. Otherwise fail closed.
 */
export function assessPersistedAirportSplit(trip: {
  airport_charge_pence?: number | null;
  commissionable_fare_pence?: number | null;
  final_fare_pence?: number | null;
  final_customer_fare_pence?: number | null;
  other_pass_through_charges_pence?: number | null;
  fare_breakdown?: unknown;
  fare_snapshot_json?: unknown;
}): PersistedAirportSplitAssessment {
  const breakdown = asRecord(trip.fare_breakdown);
  const snapshot = asRecord(trip.fare_snapshot_json);
  const quoteAirport = resolveQuoteAirportChargePence(breakdown)
    || resolveQuoteAirportChargePence(snapshot);
  const columnAirport = positiveInt(trip.airport_charge_pence) ?? 0;
  const payable = nonNegInt(trip.final_customer_fare_pence) || nonNegInt(trip.final_fare_pence);
  if (quoteAirport <= 0 && columnAirport <= 0) {
    return { ok: true, reason: "airport_absent", airportPence: 0, payablePence: payable };
  }
  if (columnAirport <= 0 || (quoteAirport > 0 && columnAirport !== quoteAirport)) {
    return { ok: false, reason: "airport_not_on_column" };
  }
  const other = nonNegInt(trip.other_pass_through_charges_pence);
  const storedCommissionable = trip.commissionable_fare_pence == null
    ? null
    : Math.max(0, Math.round(Number(trip.commissionable_fare_pence) || 0));
  const quoteRide = resolveQuoteRideFarePence(breakdown) || resolveQuoteRideFarePence(snapshot);
  const quoteFinal = resolveQuoteFinalFarePence(breakdown) || resolveQuoteFinalFarePence(snapshot);
  const storedAddsUp = storedCommissionable != null
    && payable === storedCommissionable + columnAirport + other;
  if (storedCommissionable != null && !storedAddsUp) {
    return { ok: false, reason: "split_mismatch" };
  }
  const quoteAddsUp = quoteRide > 0
    && quoteFinal === quoteRide + columnAirport
    && payable === quoteFinal + other;
  if (!storedAddsUp && !quoteAddsUp) {
    return { ok: false, reason: "split_mismatch" };
  }
  return {
    ok: true,
    reason: "split_persisted",
    airportPence: columnAirport,
    payablePence: payable,
    commissionablePence: storedCommissionable ?? Math.max(0, payable - columnAirport - other),
    otherPassThroughPence: other,
  };
}

export type AlreadyOfferedRestampDecision = {
  action: "unchanged" | "restamp" | "fail_closed";
  reason: string;
  createOffer: false;
  notify: false;
  extendExpiry: false;
  updates: PendingOfferRestampUpdate[];
};

/**
 * Pending, unexpired, non-stacked offers only. Uses the offer's stored wave
 * percent. Does not create, notify, extend expiry, or revive other statuses.
 */
export function decideAlreadyOfferedRestamp(input: {
  nowMs: number;
  trip: Parameters<typeof assessPersistedAirportSplit>[0];
  offers: ExistingOfferForRestamp[];
}): AlreadyOfferedRestampDecision {
  const empty = {
    createOffer: false as const,
    notify: false as const,
    extendExpiry: false as const,
    updates: [] as PendingOfferRestampUpdate[],
  };
  const split = assessPersistedAirportSplit(input.trip);
  if (!split.ok) {
    return { ...empty, action: "fail_closed", reason: split.reason };
  }
  if (split.reason === "airport_absent") {
    return { ...empty, action: "unchanged", reason: "airport_absent" };
  }

  const plan = planExistingPendingOfferRestamp({
    nowMs: input.nowMs,
    payablePence: split.payablePence,
    airportPence: split.airportPence,
    otherPassThroughPence: split.otherPassThroughPence,
    offers: input.offers,
    resolveWavePercent: () => Number.NaN,
    requireStoredCommissionPercent: true,
  });
  const blocking = plan.skipped.filter((row) =>
    row.reason === "rate_unresolved"
    || row.reason === "no_net"
    || row.reason === "stamp_unrepresentable"
  );
  if (blocking.length > 0) {
    return { ...empty, action: "fail_closed", reason: blocking[0].reason };
  }
  const restampedOrAlready = plan.updates.length
    + plan.skipped.filter((row) => row.reason === "already_stamped").length;
  if (restampedOrAlready === 0) {
    return { ...empty, action: "fail_closed", reason: "no_pending_offer_for_stamp" };
  }
  if (plan.updates.length === 0) {
    return { ...empty, action: "unchanged", reason: "already_stamped" };
  }
  return {
    ...empty,
    action: "restamp",
    reason: "split_persisted",
    updates: plan.updates,
  };
}
