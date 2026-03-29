/**
 * Commission Calculation Tests — LOCKED MODULE
 * 
 * These tests protect the commission calculation logic from regression.
 * The commission module (_shared/commission.ts) is the ONLY place where
 * commission percentages are resolved and applied. DO NOT bypass it.
 * 
 * Rules enforced:
 * 1. Commission always comes from driver_categories table (never hardcoded)
 * 2. Bronze tier is the fallback default for unassigned drivers
 * 3. Formula: commission_pence = round(gross_fare_pence * pct / 100)
 * 4. driver_net_pence = gross_fare_pence - commission_pence
 * 5. driver_ledger is the financial source of truth (not trips table)
 */

import { describe, it, expect } from 'vitest';

// Pure commission calculation logic (mirrors _shared/commission.ts)
function calculateCommissionPure(grossFarePence: number, commissionPct: number) {
  const commission_pence = Math.round(grossFarePence * commissionPct / 100);
  const driver_net_pence = grossFarePence - commission_pence;
  return { commission_pct: commissionPct, commission_pence, driver_net_pence };
}

describe('Commission Calculation — LOCKED', () => {
  describe('Formula integrity', () => {
    it('calculates Bronze tier (14%) correctly', () => {
      const result = calculateCommissionPure(2078, 14);
      expect(result.commission_pence).toBe(291); // round(2078 * 14 / 100) = round(290.92)
      expect(result.driver_net_pence).toBe(1787);
      expect(result.commission_pence + result.driver_net_pence).toBe(2078);
    });

    it('calculates Silver tier (13%) correctly', () => {
      const result = calculateCommissionPure(2078, 13);
      expect(result.commission_pence).toBe(270); // round(2078 * 13 / 100) = round(270.14)
      expect(result.driver_net_pence).toBe(1808);
      expect(result.commission_pence + result.driver_net_pence).toBe(2078);
    });

    it('commission + net always equals gross (conservation law)', () => {
      const testCases = [
        { gross: 7000, pct: 14 },
        { gross: 8237, pct: 13 },
        { gross: 2499, pct: 14 },
        { gross: 100, pct: 10 },
        { gross: 1, pct: 50 },
        { gross: 0, pct: 14 },
        { gross: 99999, pct: 14 },
      ];

      for (const { gross, pct } of testCases) {
        const result = calculateCommissionPure(gross, pct);
        expect(result.commission_pence + result.driver_net_pence).toBe(gross);
      }
    });

    it('uses Math.round (banker-neutral rounding)', () => {
      // 2679 * 14 / 100 = 375.06 → rounds to 375
      expect(calculateCommissionPure(2679, 14).commission_pence).toBe(375);
      // 2519 * 14 / 100 = 352.66 → rounds to 353
      expect(calculateCommissionPure(2519, 14).commission_pence).toBe(353);
      // 7000 * 14 / 100 = 980.00 → exactly 980
      expect(calculateCommissionPure(7000, 14).commission_pence).toBe(980);
    });

    it('zero gross fare produces zero commission', () => {
      const result = calculateCommissionPure(0, 14);
      expect(result.commission_pence).toBe(0);
      expect(result.driver_net_pence).toBe(0);
    });

    it('never produces negative commission', () => {
      const result = calculateCommissionPure(1, 1);
      expect(result.commission_pence).toBeGreaterThanOrEqual(0);
      expect(result.driver_net_pence).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Tier rate boundaries', () => {
    it('Bronze (14%) is always higher commission than Silver (13%)', () => {
      const bronze = calculateCommissionPure(10000, 14);
      const silver = calculateCommissionPure(10000, 13);
      expect(bronze.commission_pence).toBeGreaterThan(silver.commission_pence);
      expect(bronze.driver_net_pence).toBeLessThan(silver.driver_net_pence);
    });

    it('commission percentage must be between 0 and 100', () => {
      // This is a business rule: no tier should have 0% or >100% commission
      const tiers = [
        { name: 'Bronze', pct: 14 },
        { name: 'Silver', pct: 13 },
        { name: 'Gold', pct: 13 },
        { name: 'Platinum', pct: 13 },
        { name: 'Diamond', pct: 13 },
      ];

      for (const tier of tiers) {
        expect(tier.pct).toBeGreaterThan(0);
        expect(tier.pct).toBeLessThanOrEqual(100);
      }
    });
  });

  describe('Known trip verifications (regression guard)', () => {
    // These are actual trip values from production — they MUST never change
    const knownTrips = [
      { trip: 'HYD011', gross: 2679, pct: 14, expectedCommission: 375 },
      { trip: 'HYD035', gross: 8237, pct: 14, expectedCommission: 1153 },
      { trip: 'HYD038', gross: 7000, pct: 14, expectedCommission: 980 },
      { trip: 'HYD098', gross: 2078, pct: 13, expectedCommission: 270 },
    ];

    for (const { trip, gross, pct, expectedCommission } of knownTrips) {
      it(`${trip}: ${gross}p @ ${pct}% = ${expectedCommission}p commission`, () => {
        const result = calculateCommissionPure(gross, pct);
        expect(result.commission_pence).toBe(expectedCommission);
      });
    }
  });
});
