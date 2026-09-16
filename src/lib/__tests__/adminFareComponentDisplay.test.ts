import { describe, expect, it } from 'vitest';
import {
  ADMIN_FARE_COMPONENT_UNKNOWN,
  buildTipAirportChips,
  formatPositivePenceChipAmount,
  formatSignedStoredPenceOrUnknown,
  formatStoredPenceOrUnknown,
  isPositiveStoredPence,
  resolveTripAirportPence,
  resolveTripTipPence,
  storedPenceDifference,
  sumKnownEntitlementComponentsPence,
} from '@/lib/adminFareComponentDisplay';

describe('adminFareComponentDisplay', () => {
  it('formats GBP from pence and never shows £0.00 for missing', () => {
    expect(formatStoredPenceOrUnknown(null)).toBe(ADMIN_FARE_COMPONENT_UNKNOWN);
    expect(formatStoredPenceOrUnknown(undefined)).toBe(ADMIN_FARE_COMPONENT_UNKNOWN);
    expect(formatStoredPenceOrUnknown(0)).toBe('£0.00');
    expect(formatStoredPenceOrUnknown(576)).toBe('£5.76');
  });

  it('hides zero / null chip amounts (no zero clutter)', () => {
    expect(formatPositivePenceChipAmount(null)).toBeNull();
    expect(formatPositivePenceChipAmount(0)).toBeNull();
    expect(formatPositivePenceChipAmount(100)).toBe('£1.00');
    expect(isPositiveStoredPence(0)).toBe(false);
  });

  it('builds tip chip only', () => {
    const chips = buildTipAirportChips({ tipPence: 200, airportPence: 0 });
    expect(chips).toHaveLength(1);
    expect(chips[0]?.label).toBe('Tip +£2.00');
    expect(chips[0]?.ariaLabel).toContain('Tip');
  });

  it('builds airport chip only', () => {
    const chips = buildTipAirportChips({ tipPence: null, airportPence: 500 });
    expect(chips).toHaveLength(1);
    expect(chips[0]?.label).toBe('Airport +£5.00');
  });

  it('builds both chips when tip and airport known and > 0', () => {
    const chips = buildTipAirportChips({ tipPence: 150, airportPence: 500 });
    expect(chips.map((c) => c.key)).toEqual(['airport', 'tip']);
    expect(chips[0]?.label).toBe('Airport +£5.00');
    expect(chips[1]?.label).toBe('Tip +£1.50');
  });

  it('omits chips for unknown legacy (null) without inventing zeros', () => {
    expect(buildTipAirportChips({ tipPence: null, airportPence: null })).toEqual([]);
    expect(resolveTripTipPence({ tip_pence: null, tip_amount_pence: null })).toBeNull();
    expect(resolveTripAirportPence({ airport_charge_pence: null })).toBeNull();
  });

  it('prefers tip_pence then tip_amount_pence; airport_charge then airport_pence', () => {
    expect(resolveTripTipPence({ tip_pence: 100, tip_amount_pence: 200 })).toBe(100);
    expect(resolveTripTipPence({ tip_pence: null, tip_amount_pence: 200 })).toBe(200);
    expect(resolveTripAirportPence({ airport_charge_pence: 500, airport_pence: 1 })).toBe(500);
    expect(resolveTripAirportPence({ airport_pence: 500 })).toBe(500);
  });

  it('sums entitlement components only when all known; difference preserves sign', () => {
    expect(sumKnownEntitlementComponentsPence({
      fareNetPence: 637,
      airportPence: 500,
      tipPence: 100,
    })).toBe(1237);
    expect(sumKnownEntitlementComponentsPence({
      fareNetPence: 637,
      airportPence: null,
      tipPence: 100,
    })).toBeNull();
    expect(storedPenceDifference(1200, 1237)).toBe(-37);
    expect(formatSignedStoredPenceOrUnknown(-37)).toBe('−£0.37');
    expect(formatSignedStoredPenceOrUnknown(50)).toBe('+£0.50');
    expect(formatSignedStoredPenceOrUnknown(null)).toBe(ADMIN_FARE_COMPONENT_UNKNOWN);
  });
});
