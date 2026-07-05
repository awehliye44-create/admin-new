import { describe, expect, it } from 'vitest';
import { derivePaymentActionAvailability, isDigitalTripPayment } from '@/lib/financeTripActionsSSOT';

describe('isDigitalTripPayment', () => {
  it('treats card as digital', () => {
    expect(isDigitalTripPayment('card')).toBe(true);
  });
  it('excludes cash', () => {
    expect(isDigitalTripPayment('cash')).toBe(false);
  });
});

describe('derivePaymentActionAvailability', () => {
  it('enables capture and cancel when authorised', () => {
    const rules = derivePaymentActionAvailability({
      paymentMethod: 'card',
      stripeStatus: 'requires_capture',
      amountCapturablePence: 500,
      hasPaymentIntent: true,
      authorizedPence: 500,
    });
    expect(rules.capture.enabled).toBe(true);
    expect(rules.cancel_authorisation.enabled).toBe(true);
    expect(rules.void_payment.enabled).toBe(true);
    expect(rules.refund_full.enabled).toBe(false);
  });

  it('enables refunds when captured', () => {
    const rules = derivePaymentActionAvailability({
      paymentMethod: 'card',
      stripeStatus: 'succeeded',
      capturedPence: 1000,
      refundablePence: 1000,
      hasPaymentIntent: true,
      hasCharge: true,
    });
    expect(rules.refund_full.enabled).toBe(true);
    expect(rules.refund_partial.enabled).toBe(true);
    expect(rules.capture.enabled).toBe(false);
  });

  it('disables refunds when fully refunded but keeps history actions conceptually available', () => {
    const rules = derivePaymentActionAvailability({
      paymentMethod: 'card',
      stripeStatus: 'succeeded',
      capturedPence: 1000,
      refundedPence: 1000,
      refundablePence: 0,
      hasPaymentIntent: true,
      hasCharge: true,
    });
    expect(rules.refund_full.enabled).toBe(false);
    expect(rules.refund_full.reason).toMatch(/refund/i);
    expect(rules.resync_stripe.enabled).toBe(true);
  });

  it('does not gate actions on reconciliation health — outstanding enables extra payment', () => {
    const rules = derivePaymentActionAvailability({
      paymentMethod: 'card',
      stripeStatus: 'succeeded',
      capturedPence: 800,
      refundablePence: 800,
      outstandingPence: 200,
      hasPaymentIntent: true,
      hasCharge: true,
    });
    expect(rules.request_extra_payment.enabled).toBe(true);
    expect(rules.repair_settlement.enabled).toBe(true);
  });

  it('respects server actions_allowed SSOT', () => {
    const rules = derivePaymentActionAvailability({
      paymentMethod: 'card',
      stripeStatus: 'requires_capture',
      amountCapturablePence: 500,
      hasPaymentIntent: true,
      actionsAllowed: { can_capture: false, can_cancel_authorisation: false },
    });
    expect(rules.capture.enabled).toBe(false);
    expect(rules.cancel_authorisation.enabled).toBe(false);
  });
});
