import { describe, expect, it } from 'vitest';
import {
  isInvoiceEmailAllowed,
  resolveTripInvoicePaymentState,
} from '../tripInvoicePaymentStateSSOT';

const cardTrip = (overrides: Record<string, unknown> = {}) => ({
  id: 'trip-a',
  status: 'completed',
  payment_method: 'card',
  payment_collection_model: 'PLATFORM_COLLECTED',
  final_fare_pence: 2000,
  ...overrides,
});

describe('resolveTripInvoicePaymentState — invoice payment SSOT', () => {
  it('TEST 1 — fully paid', () => {
    const state = resolveTripInvoicePaymentState({
      trip: cardTrip(),
      paymentSessions: [
        { trip_id: 'trip-a', status: 'captured', captured_amount_pence: 2000, provider_payment_id: 'p1' },
      ],
    });
    expect(state.paymentClassification).toBe('FULLY_PAID');
    expect(state.authoritativePaidPence).toBe(2000);
    expect(state.outstandingPence).toBe(0);
    expect(isInvoiceEmailAllowed(state)).toBe(true);
  });

  it('TEST 2 — partial payment shows exact captured amount', () => {
    const state = resolveTripInvoicePaymentState({
      trip: cardTrip(),
      paymentSessions: [
        { trip_id: 'trip-a', status: 'captured', captured_amount_pence: 1350, provider_payment_id: 'p2' },
      ],
    });
    expect(state.paymentClassification).toBe('PARTIALLY_PAID');
    expect(state.authoritativePaidPence).toBe(1350);
    expect(state.outstandingPence).toBe(650);
    expect(isInvoiceEmailAllowed(state)).toBe(true);
  });

  it('TEST 3 — failed payment blocks invoice email', () => {
    const state = resolveTripInvoicePaymentState({
      trip: cardTrip({ payment_status: 'capture_failed' }),
      paymentSessions: [
        { trip_id: 'trip-a', status: 'capture_failed', captured_amount_pence: 0, authorised_amount_pence: 2000 },
      ],
    });
    expect(state.paymentClassification).toBe('PAYMENT_FAILED');
    expect(state.authoritativePaidPence).toBe(0);
    expect(isInvoiceEmailAllowed(state)).toBe(false);
  });

  it('TEST 4 — authorised is never treated as paid', () => {
    const state = resolveTripInvoicePaymentState({
      trip: cardTrip({ payment_status: 'authorised_hold' }),
      paymentSessions: [
        { trip_id: 'trip-a', status: 'authorised_hold', authorised_amount_pence: 2000, captured_amount_pence: 0 },
      ],
    });
    expect(state.authoritativePaidPence).toBe(0);
    expect(state.paymentClassification).toBe('PAYMENT_PENDING');
    expect(isInvoiceEmailAllowed(state)).toBe(false);
  });

  it('TEST 5 — capture shortfall', () => {
    const state = resolveTripInvoicePaymentState({
      trip: cardTrip({ final_fare_pence: 1388 }),
      paymentSessions: [
        { trip_id: 'trip-a', status: 'captured', captured_amount_pence: 1089, provider_payment_id: 'p5' },
      ],
    });
    expect(state.authoritativePaidPence).toBe(1089);
    expect(state.outstandingPence).toBe(299);
    expect(state.paymentClassification).toBe('PARTIALLY_PAID');
  });

  it('TEST 6 — stacked trips stay independent', () => {
    const sessions = [
      { trip_id: 'trip-a', status: 'captured', captured_amount_pence: 1000, provider_payment_id: 'pa' },
      { trip_id: 'trip-b', status: 'capture_failed', captured_amount_pence: 0, provider_payment_id: 'pb' },
    ];
    const a = resolveTripInvoicePaymentState({
      trip: cardTrip({ id: 'trip-a', final_fare_pence: 1000 }),
      paymentSessions: sessions,
    });
    const b = resolveTripInvoicePaymentState({
      trip: cardTrip({ id: 'trip-b', final_fare_pence: 1500, payment_status: 'capture_failed' }),
      paymentSessions: sessions,
    });
    expect(a.paymentClassification).toBe('FULLY_PAID');
    expect(b.authoritativePaidPence).toBe(0);
    expect(b.paymentClassification).toBe('PAYMENT_FAILED');
    expect(isInvoiceEmailAllowed(b)).toBe(false);
  });

  it('TEST 7 — duplicate capture events counted once', () => {
    const state = resolveTripInvoicePaymentState({
      trip: cardTrip(),
      paymentSessions: [
        { trip_id: 'trip-a', status: 'captured', captured_amount_pence: 2000, provider_payment_id: 'dup-1' },
      ],
      payments: [
        { trip_id: 'trip-a', status: 'captured', captured_amount_pence: 2000, provider_payment_id: 'dup-1' },
      ],
    });
    expect(state.authoritativePaidPence).toBe(2000);
  });

  it('TEST 8 — pending at completion, eligible after provider confirms', () => {
    const pending = resolveTripInvoicePaymentState({ trip: cardTrip(), paymentSessions: [] });
    expect(pending.paymentClassification).toBe('PAYMENT_PENDING');
    expect(isInvoiceEmailAllowed(pending)).toBe(false);

    const confirmed = resolveTripInvoicePaymentState({
      trip: cardTrip(),
      paymentSessions: [
        { trip_id: 'trip-a', status: 'captured', captured_amount_pence: 2000, provider_payment_id: 'late-1' },
      ],
    });
    expect(isInvoiceEmailAllowed(confirmed)).toBe(true);
  });

  it('multiple legitimate recovery captures sum', () => {
    const state = resolveTripInvoicePaymentState({
      trip: cardTrip(),
      paymentSessions: [
        { trip_id: 'trip-a', status: 'captured', captured_amount_pence: 1500, provider_payment_id: 'r1' },
        { trip_id: 'trip-a', status: 'recovery_completed', captured_amount_pence: 500, provider_payment_id: 'r2' },
      ],
    });
    expect(state.authoritativePaidPence).toBe(2000);
    expect(state.paymentClassification).toBe('FULLY_PAID');
  });

  it('full refund blocks invoice', () => {
    const state = resolveTripInvoicePaymentState({
      trip: cardTrip(),
      paymentSessions: [
        {
          trip_id: 'trip-a',
          status: 'captured',
          captured_amount_pence: 2000,
          refunded_amount_pence: 2000,
          provider_payment_id: 'rf1',
        },
      ],
    });
    expect(state.paymentClassification).toBe('REFUNDED');
    expect(isInvoiceEmailAllowed(state)).toBe(false);
  });

  it('driver-collected trip is not unpaid merely because no card capture exists', () => {
    const state = resolveTripInvoicePaymentState({
      trip: {
        id: 'trip-dc',
        payment_method: 'cash',
        payment_collection_model: 'DRIVER_COLLECTED_COMMISSION_WALLET',
        final_fare_pence: 793,
        cash_collected_at: '2026-08-01T10:00:00Z',
      },
    });
    expect(state.paymentClassification).toBe('FULLY_PAID');
    expect(state.authoritativePaidPence).toBe(793);
  });

  it('driver-collected without collection evidence fails closed', () => {
    const state = resolveTripInvoicePaymentState({
      trip: {
        id: 'trip-dc2',
        payment_method: 'cash',
        payment_collection_model: 'DRIVER_COLLECTED_COMMISSION_WALLET',
        final_fare_pence: 793,
      },
    });
    expect(state.paymentClassification).toBe('PAYMENT_PENDING');
    expect(isInvoiceEmailAllowed(state)).toBe(false);
  });
});
