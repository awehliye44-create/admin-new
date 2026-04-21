/**
 * ONECAB Fare Engine — Shared pricing logic
 * 
 * Strategy pattern: FixedPricingStrategy / DynamicPricingStrategy
 * All monetary values in pence (integer).
 */

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
  // ── Pricing Buffer (Stripe / margin) ──
  buffer_enabled?: boolean;
  buffer_type?: 'fixed' | 'percentage';
  buffer_value?: number; // fixed: currency units (e.g. 0.50). percentage: percent (e.g. 2.5)
  buffer_apply_scope?: 'all' | 'non_route';
  buffer_show_to_customer?: boolean;
}

export interface PricingBufferConfig {
  enabled: boolean;
  type: 'fixed' | 'percentage';
  value: number;
  apply_scope: 'all' | 'non_route';
  show_to_customer: boolean;
}

export interface PricingBufferResult {
  buffer_amount_pence: number;
  applied: boolean;
  reason?: string;
}

/**
 * Compute the pricing buffer to add on top of a base fare.
 *
 * Strict rules:
 *   • Buffer is added AFTER fare calculation, BEFORE any discount.
 *   • Buffer is NEVER mixed into base_fare_pence.
 *   • Buffer is platform-only revenue: it does NOT change driver earnings or commission.
 *   • If the fare source is "zone_route" (a fixed route price) and apply_scope is
 *     "non_route", the buffer is skipped.
 */
export function computePricingBuffer(
  basePence: number,
  cfg: PricingBufferConfig | null | undefined,
  fareSource: 'meter' | 'zone_route',
): PricingBufferResult {
  if (!cfg || !cfg.enabled || cfg.value <= 0 || basePence <= 0) {
    return { buffer_amount_pence: 0, applied: false, reason: 'buffer_disabled_or_zero' };
  }
  if (cfg.apply_scope === 'non_route' && fareSource === 'zone_route') {
    return { buffer_amount_pence: 0, applied: false, reason: 'scope_excludes_zone_route' };
  }

  let bufferPence: number;
  if (cfg.type === 'fixed') {
    // value is in currency units; convert to pence
    bufferPence = Math.round(cfg.value * 100);
  } else {
    // percentage of the base fare
    bufferPence = Math.round((basePence * cfg.value) / 100);
  }
  return { buffer_amount_pence: Math.max(0, bufferPence), applied: bufferPence > 0 };
}

/** Read a PricingBufferConfig from a fare_pricing_settings row (or null). */
export function bufferConfigFromSettings(
  row: Partial<FarePricingSettings> | null | undefined,
): PricingBufferConfig | null {
  if (!row) return null;
  return {
    enabled: !!row.buffer_enabled,
    type: (row.buffer_type as 'fixed' | 'percentage') ?? 'fixed',
    value: Number(row.buffer_value ?? 0),
    apply_scope: (row.buffer_apply_scope as 'all' | 'non_route') ?? 'all',
    show_to_customer: !!row.buffer_show_to_customer,
  };
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
    const distance = Math.round(req.estimated_distance_km * this.settings.per_km_rate_pence);
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
    const distance = Math.round(additionalDistanceKm * this.settings.per_km_rate_pence);
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
