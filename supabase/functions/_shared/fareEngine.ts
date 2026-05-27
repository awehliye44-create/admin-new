/**
 * ONECAB Fare Engine — Shared pricing logic
 * 
 * Strategy pattern: FixedPricingStrategy / DynamicPricingStrategy
 * All monetary values in pence (integer).
 */

export interface DistanceBand {
  /** From distance, expressed in the Service Area's distance_unit. */
  from: number;
  /** To distance (exclusive upper bound). null = "and above". */
  to: number | null;
  /** Rate per unit, in minor currency (pence/cents). */
  rate_pence: number;
}

export interface FarePricingSettings {
  pricing_mode: 'fixed' | 'dynamic';
  currency_code: string;
  base_fare_pence: number;
  per_km_rate_pence: number;
  per_min_rate_pence: number;
  booking_fee_pence: number;
  minimum_fare_pence: number;
  free_waiting_minutes: number;
  waiting_per_minute_pence: number;
  extra_stop_flat_fee_pence: number;
  recalculate_on_waiting: boolean;
  recalculate_on_stop_added: boolean;
  recalculate_on_dropoff_changed: boolean;
  enable_surge: boolean;
  surge_multiplier_default: number;
  peak_hour_multiplier: number;
  zone_multiplier: number;
  traffic_multiplier: number;
  demand_supply_multiplier: number;
  /** Tiered distance pricing. If present and non-empty, overrides per_km_rate_pence. */
  distance_pricing_bands?: DistanceBand[] | null;
  /** Service Area distance unit ('mile' | 'km'). Required when distance_pricing_bands is set. */
  distance_unit?: 'mile' | 'km' | string;
}

const KM_PER_MILE = 1.609344;

/**
 * Calculate the distance charge in pence.
 * - If distance_pricing_bands is set, applies tiered rates in the SA's distance_unit.
 * - Otherwise falls back to the flat per_km_rate_pence.
 */
export function calculateDistanceCharge(
  estimatedDistanceKm: number,
  settings: Pick<FarePricingSettings, 'per_km_rate_pence' | 'distance_pricing_bands' | 'distance_unit'>,
): number {
  const bands = settings.distance_pricing_bands;
  if (!bands || bands.length === 0) {
    return Math.round(estimatedDistanceKm * settings.per_km_rate_pence);
  }
  const isMiles = (settings.distance_unit ?? 'km').toLowerCase().startsWith('mi');
  const tripDist = isMiles ? estimatedDistanceKm / KM_PER_MILE : estimatedDistanceKm;
  let charge = 0;
  const sorted = [...bands].sort((a, b) => (a.from ?? 0) - (b.from ?? 0));
  for (const b of sorted) {
    const upper = b.to == null ? Infinity : b.to;
    const span = Math.max(0, Math.min(tripDist, upper) - (b.from ?? 0));
    if (span > 0) charge += span * (b.rate_pence ?? 0);
  }
  return Math.round(charge);
}

export interface FareEstimateRequest {
  estimated_distance_km: number;
  estimated_duration_min: number;
  stops_count?: number;
}

export interface FareBreakdown {
  base_fare_pence: number;
  distance_charge_pence: number;
  time_charge_pence: number;
  booking_fee_pence: number;
  subtotal_pence: number;
  minimum_applied: boolean;
  quoted_fare_pence: number;
  // Dynamic-only
  surge_multiplier?: number;
  zone_multiplier?: number;
  traffic_multiplier?: number;
}

export interface WaitingChargeResult {
  billable_minutes: number;
  waiting_charge_pence: number;
}

export interface StopAdjustmentResult {
  flat_fee_pence: number;
  distance_charge_pence: number;
  time_charge_pence: number;
  total_adjustment_pence: number;
}

export interface DestinationChangeResult {
  old_route_fare_pence: number;
  new_route_fare_pence: number;
  adjustment_pence: number;
}

export interface FinalFareResult {
  quoted_fare_pence: number;
  waiting_charge_pence: number;
  stop_charge_total_pence: number;
  destination_change_adjustment_pence: number;
  final_fare_pence: number;
  breakdown: FareBreakdown;
}

// ─── FIXED PRICING STRATEGY ───

export class FixedPricingStrategy {
  constructor(private settings: FarePricingSettings) {}

  calculateInitialQuote(req: FareEstimateRequest): FareBreakdown {
    const base = this.settings.base_fare_pence;
    const distance = calculateDistanceCharge(req.estimated_distance_km, this.settings);
    const time = Math.round(req.estimated_duration_min * this.settings.per_min_rate_pence);
    const booking = this.settings.booking_fee_pence;

    const subtotal = base + distance + time + booking;
    const minimumApplied = subtotal < this.settings.minimum_fare_pence;
    const quoted = Math.max(subtotal, this.settings.minimum_fare_pence);

    return {
      base_fare_pence: base,
      distance_charge_pence: distance,
      time_charge_pence: time,
      booking_fee_pence: booking,
      subtotal_pence: subtotal,
      minimum_applied: minimumApplied,
      quoted_fare_pence: quoted,
    };
  }

  calculateWaitingCharge(actualWaitingMinutes: number): WaitingChargeResult {
    if (!this.settings.recalculate_on_waiting) {
      return { billable_minutes: 0, waiting_charge_pence: 0 };
    }

    const billable = Math.max(0, actualWaitingMinutes - this.settings.free_waiting_minutes);
    const charge = Math.round(billable * this.settings.waiting_per_minute_pence);

    return { billable_minutes: billable, waiting_charge_pence: charge };
  }

  calculateStopAdjustment(
    additionalDistanceKm: number,
    additionalDurationMin: number
  ): StopAdjustmentResult {
    if (!this.settings.recalculate_on_stop_added) {
      return { flat_fee_pence: 0, distance_charge_pence: 0, time_charge_pence: 0, total_adjustment_pence: 0 };
    }

    const flat = this.settings.extra_stop_flat_fee_pence;
    const distance = calculateDistanceCharge(additionalDistanceKm, this.settings);
    const time = Math.round(additionalDurationMin * this.settings.per_min_rate_pence);

    return {
      flat_fee_pence: flat,
      distance_charge_pence: distance,
      time_charge_pence: time,
      total_adjustment_pence: flat + distance + time,
    };
  }

  calculateDestinationAdjustment(
    currentQuotedFarePence: number,
    newEstimatedDistanceKm: number,
    newEstimatedDurationMin: number
  ): DestinationChangeResult {
    if (!this.settings.recalculate_on_dropoff_changed) {
      return { old_route_fare_pence: currentQuotedFarePence, new_route_fare_pence: currentQuotedFarePence, adjustment_pence: 0 };
    }

    const newBreakdown = this.calculateInitialQuote({
      estimated_distance_km: newEstimatedDistanceKm,
      estimated_duration_min: newEstimatedDurationMin,
    });

    const adjustment = newBreakdown.quoted_fare_pence - currentQuotedFarePence;

    return {
      old_route_fare_pence: currentQuotedFarePence,
      new_route_fare_pence: newBreakdown.quoted_fare_pence,
      adjustment_pence: adjustment,
    };
  }
}

// ─── DYNAMIC PRICING STRATEGY ───

export class DynamicPricingStrategy {
  constructor(private settings: FarePricingSettings) {}

  calculateInitialQuote(req: FareEstimateRequest): FareBreakdown {
    const base = this.settings.base_fare_pence;
    const distance = Math.round(req.estimated_distance_km * this.settings.per_km_rate_pence);
    const time = Math.round(req.estimated_duration_min * this.settings.per_min_rate_pence);
    const booking = this.settings.booking_fee_pence;

    const surgeMultiplier = this.settings.enable_surge ? this.settings.surge_multiplier_default : 1;
    const zoneMultiplier = this.settings.zone_multiplier;
    const trafficMultiplier = this.settings.traffic_multiplier;

    const rawSubtotal = base + distance + time;
    const multiplied = Math.round(rawSubtotal * surgeMultiplier * zoneMultiplier * trafficMultiplier);
    const subtotal = multiplied + booking;

    const minimumApplied = subtotal < this.settings.minimum_fare_pence;
    const quoted = Math.max(subtotal, this.settings.minimum_fare_pence);

    return {
      base_fare_pence: base,
      distance_charge_pence: distance,
      time_charge_pence: time,
      booking_fee_pence: booking,
      subtotal_pence: subtotal,
      minimum_applied: minimumApplied,
      quoted_fare_pence: quoted,
      surge_multiplier: surgeMultiplier,
      zone_multiplier: zoneMultiplier,
      traffic_multiplier: trafficMultiplier,
    };
  }

  calculateLiveFare(
    actualDistanceKm: number,
    actualDurationMin: number
  ): FareBreakdown {
    return this.calculateInitialQuote({
      estimated_distance_km: actualDistanceKm,
      estimated_duration_min: actualDurationMin,
    });
  }
}

// ─── FARE ENGINE (Facade) ───

export class FareEngine {
  private fixedStrategy: FixedPricingStrategy;
  private dynamicStrategy: DynamicPricingStrategy;

  constructor(private settings: FarePricingSettings) {
    this.fixedStrategy = new FixedPricingStrategy(settings);
    this.dynamicStrategy = new DynamicPricingStrategy(settings);
  }

  get pricingMode() {
    return this.settings.pricing_mode;
  }

  estimateFare(req: FareEstimateRequest): FareBreakdown {
    if (this.settings.pricing_mode === 'dynamic') {
      return this.dynamicStrategy.calculateInitialQuote(req);
    }
    return this.fixedStrategy.calculateInitialQuote(req);
  }

  calculateWaitingCharge(actualWaitingMinutes: number): WaitingChargeResult {
    return this.fixedStrategy.calculateWaitingCharge(actualWaitingMinutes);
  }

  calculateStopAdjustment(
    additionalDistanceKm: number,
    additionalDurationMin: number
  ): StopAdjustmentResult {
    return this.fixedStrategy.calculateStopAdjustment(additionalDistanceKm, additionalDurationMin);
  }

  calculateDestinationAdjustment(
    currentQuotedFarePence: number,
    newEstimatedDistanceKm: number,
    newEstimatedDurationMin: number
  ): DestinationChangeResult {
    return this.fixedStrategy.calculateDestinationAdjustment(
      currentQuotedFarePence,
      newEstimatedDistanceKm,
      newEstimatedDurationMin
    );
  }

  calculateFinalFare(
    quotedFarePence: number,
    waitingMinutes: number,
    stopChargeTotalPence: number,
    destinationChangeAdjustmentPence: number
  ): number {
    if (this.settings.pricing_mode === 'fixed') {
      const waitingResult = this.calculateWaitingCharge(waitingMinutes);
      const total = quotedFarePence +
        waitingResult.waiting_charge_pence +
        stopChargeTotalPence +
        destinationChangeAdjustmentPence;
      return Math.max(0, total);
    }
    // Dynamic mode: fare is calculated live, adjustments still apply
    const waitingResult = this.calculateWaitingCharge(waitingMinutes);
    const total = quotedFarePence +
      waitingResult.waiting_charge_pence +
      stopChargeTotalPence +
      destinationChangeAdjustmentPence;
    return Math.max(0, total);
  }
}
