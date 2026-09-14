import { describe, expect, it } from 'vitest';
import {
  buildPaymentStateMoneyBreakdown,
  recaptureAllowedFromSsotOutstanding,
} from '../../../shared/paymentStateMoneyBreakdownSSOT';

describe('buildPaymentStateMoneyBreakdown', () => {
  it('MK-260912-005: fare 500, tip 100, captured 600 — no shortfall, no recapture', () => {
    const result = buildPaymentStateMoneyBreakdown({
      farePence: 500,
      tipPence: 100,
      airportChargePence: 0,
      customerPayablePence: 600,
      verifiedCapturedPence: 600,
      verifiedRefundedPence: 0,
      outstandingShortfallPence: 0,
      storedOutstandingBalancePence: 0,
      commissionableFarePence: 500,
    });

    expect(result.fare_pence).toBe(500);
    expect(result.tip_pence).toBe(100);
    expect(result.airport_charge_pence).toBe(0);
    expect(result.non_commissionable_total_pence).toBe(100);
    expect(result.customer_payable_pence).toBe(600);
    expect(result.verified_captured_pence).toBe(600);
    expect(result.outstanding_shortfall_pence).toBe(0);
    expect(result.commissionable_fare_pence).toBe(500);
    expect(result.show_recapture).toBe(false);
    expect(result.customer_payable_pence).not.toBe(result.fare_pence + result.tip_pence + result.tip_pence);
  });

  it('does not invent payable by adding tip onto an already-inclusive total', () => {
    const result = buildPaymentStateMoneyBreakdown({
      farePence: 500,
      tipPence: 100,
      customerPayablePence: 600,
      verifiedCapturedPence: 600,
      outstandingShortfallPence: 0,
    });
    expect(result.customer_payable_pence).toBe(600);
    expect(result.outstanding_shortfall_pence).toBe(0);
    expect(result.show_recapture).toBe(false);
  });

  it('fare 500, tip 100, captured 500 — true £1 shortfall from SSOT outstanding', () => {
    const result = buildPaymentStateMoneyBreakdown({
      farePence: 500,
      tipPence: 100,
      airportChargePence: 0,
      customerPayablePence: 600,
      verifiedCapturedPence: 500,
      outstandingShortfallPence: 100,
      storedOutstandingBalancePence: 100,
      commissionableFarePence: 500,
    });

    expect(result.customer_payable_pence).toBe(600);
    expect(result.outstanding_shortfall_pence).toBe(100);
    expect(result.commissionable_fare_pence).toBe(500);
    expect(result.show_recapture).toBe(true);
  });

  it('fare 500, airport 200, tip 100, captured 800 — no shortfall, commissionable 500', () => {
    const result = buildPaymentStateMoneyBreakdown({
      farePence: 500,
      tipPence: 100,
      airportChargePence: 200,
      customerPayablePence: 800,
      verifiedCapturedPence: 800,
      outstandingShortfallPence: 0,
      storedOutstandingBalancePence: 0,
      commissionableFarePence: 500,
    });

    expect(result.fare_pence).toBe(500);
    expect(result.tip_pence).toBe(100);
    expect(result.airport_charge_pence).toBe(200);
    expect(result.non_commissionable_total_pence).toBe(300);
    expect(result.customer_payable_pence).toBe(800);
    expect(result.outstanding_shortfall_pence).toBe(0);
    expect(result.commissionable_fare_pence).toBe(500);
    expect(result.show_recapture).toBe(false);
    expect(result.customer_payable_pence).not.toBe(result.fare_pence);
  });

  it('fare 500, no tip or airport, captured 500 — no shortfall', () => {
    const result = buildPaymentStateMoneyBreakdown({
      farePence: 500,
      tipPence: 0,
      airportChargePence: 0,
      customerPayablePence: 500,
      verifiedCapturedPence: 500,
      outstandingShortfallPence: 0,
      commissionableFarePence: 500,
    });

    expect(result.tip_pence).toBe(0);
    expect(result.non_commissionable_total_pence).toBe(0);
    expect(result.customer_payable_pence).toBe(500);
    expect(result.outstanding_shortfall_pence).toBe(0);
    expect(result.show_recapture).toBe(false);
  });

  it('never allows recapture from a locally recomputed shortfall when SSOT outstanding is 0', () => {
    expect(recaptureAllowedFromSsotOutstanding(0, 100)).toBe(false);
    expect(recaptureAllowedFromSsotOutstanding(null, 100)).toBe(false);
    expect(recaptureAllowedFromSsotOutstanding(undefined, 700)).toBe(false);
    expect(recaptureAllowedFromSsotOutstanding(100, 0)).toBe(true);
  });
});
