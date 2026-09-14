import { describe, expect, it } from 'vitest';
import { resolveTripHistoryShortfallFromPaymentState } from '../tripHistoryShortfallPaymentState';

describe('resolveTripHistoryShortfallFromPaymentState', () => {
  it('MK-260912-005: fare 500 + tip 100 already in payable 600, captured 600 — no recapture', () => {
    const result = resolveTripHistoryShortfallFromPaymentState({
      customerPayablePence: 600,
      verifiedCapturedPence: 600,
      refundedPence: 0,
      paymentStateOutstandingPence: 0,
      storedOutstandingBalancePence: 0,
      tipPence: 100,
      airportChargePence: 0,
    });

    expect(result.customerPayablePence).toBe(600);
    expect(result.verifiedCapturedPence).toBe(600);
    expect(result.outstandingShortfallPence).toBe(0);
    expect(result.showRecapture).toBe(false);
  });

  it('does not add tip when payment-state outstanding is omitted and capture covers payable', () => {
    const result = resolveTripHistoryShortfallFromPaymentState({
      customerPayablePence: 600,
      verifiedCapturedPence: 600,
      storedOutstandingBalancePence: 0,
      tipPence: 100,
    });

    expect(result.customerPayablePence).toBe(600);
    expect(result.outstandingShortfallPence).toBe(0);
    expect(result.showRecapture).toBe(false);
  });

  it('fare 500 + tip 100, payable 600, captured 500 — recapture the unpaid tip only', () => {
    const result = resolveTripHistoryShortfallFromPaymentState({
      customerPayablePence: 600,
      verifiedCapturedPence: 500,
      paymentStateOutstandingPence: 100,
      storedOutstandingBalancePence: 100,
      tipPence: 100,
    });

    expect(result.customerPayablePence).toBe(600);
    expect(result.outstandingShortfallPence).toBe(100);
    expect(result.showRecapture).toBe(true);
  });

  it('airport already inside payable is not added again', () => {
    const settled = resolveTripHistoryShortfallFromPaymentState({
      customerPayablePence: 700,
      verifiedCapturedPence: 700,
      paymentStateOutstandingPence: 0,
      storedOutstandingBalancePence: 0,
      tipPence: 100,
      airportChargePence: 100,
    });
    expect(settled.customerPayablePence).toBe(700);
    expect(settled.outstandingShortfallPence).toBe(0);
    expect(settled.showRecapture).toBe(false);

    const short = resolveTripHistoryShortfallFromPaymentState({
      customerPayablePence: 700,
      verifiedCapturedPence: 600,
      paymentStateOutstandingPence: 100,
      storedOutstandingBalancePence: 100,
      tipPence: 100,
      airportChargePence: 100,
    });
    expect(short.customerPayablePence).toBe(700);
    expect(short.outstandingShortfallPence).toBe(100);
    expect(short.showRecapture).toBe(true);
  });

  it('hides recapture when stored outstanding and payment-state outstanding are both 0', () => {
    const result = resolveTripHistoryShortfallFromPaymentState({
      customerPayablePence: 600,
      verifiedCapturedPence: 500,
      paymentStateOutstandingPence: 0,
      storedOutstandingBalancePence: 0,
      tipPence: 100,
    });

    expect(result.outstandingShortfallPence).toBe(0);
    expect(result.showRecapture).toBe(false);
  });
});
