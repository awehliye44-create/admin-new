import { describe, expect, it } from 'vitest';
import {
  isInvoiceEmailAllowed,
  resolveTripInvoicePaymentState,
} from '../../../shared/tripInvoicePaymentStateSSOT';

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

describe('capture mirror dedupe — payments row mirrors payment_sessions capture', () => {
  it('MIRROR — 982 session + 982 unidentified payments mirror = 982 (not 1964)', () => {
    const state = resolveTripInvoicePaymentState({
      trip: cardTrip({ final_fare_pence: 716 }),
      paymentSessions: [
        {
          trip_id: 'trip-a',
          status: 'trip_created',
          provider_state: 'completed',
          captured_amount_pence: 982,
          authorised_amount_pence: 982,
          refunded_amount_pence: 266,
          provider_order_id: '6a80b18b',
        },
      ],
      payments: [
        {
          id: 'pay-1',
          trip_id: 'trip-a',
          status: 'partially_refunded',
          amount_pence: 450,
          captured_amount_pence: 982,
          provider_payment_id: null,
        },
      ],
    });
    expect(state.authoritativePaidPence).toBe(716);
    expect(state.refundedPence).toBe(266);
    expect(state.outstandingPence).toBe(0);
    expect(state.paymentClassification).toBe('FULLY_PAID');
    expect(isInvoiceEmailAllowed(state)).toBe(true);
  });

  it('MIRROR — normal 450 trip resolves to 450 (not 900)', () => {
    const state = resolveTripInvoicePaymentState({
      trip: cardTrip({ final_fare_pence: 450 }),
      paymentSessions: [
        { trip_id: 'trip-a', status: 'captured', captured_amount_pence: 450, provider_order_id: 'ord-450' },
      ],
      payments: [
        { id: 'pay-450', trip_id: 'trip-a', status: 'captured', captured_amount_pence: 450 },
      ],
    });
    expect(state.authoritativePaidPence).toBe(450);
    expect(state.paymentClassification).toBe('FULLY_PAID');
  });

  it('INDEPENDENT — two provider-identified captures still sum', () => {
    const state = resolveTripInvoicePaymentState({
      trip: cardTrip({ final_fare_pence: 700 }),
      paymentSessions: [
        { trip_id: 'trip-a', status: 'captured', captured_amount_pence: 500, provider_capture_id: 'cap-A' },
      ],
      payments: [
        { id: 'pay-B', trip_id: 'trip-a', status: 'captured', captured_amount_pence: 200, provider_payment_id: 'cap-B' },
      ],
    });
    expect(state.authoritativePaidPence).toBe(700);
    expect(state.paymentClassification).toBe('FULLY_PAID');
  });

  it('AUTHORISATION — authorised 1000 / captured 700 pays 700', () => {
    const state = resolveTripInvoicePaymentState({
      trip: cardTrip({ final_fare_pence: 700 }),
      paymentSessions: [
        {
          trip_id: 'trip-a',
          status: 'captured',
          authorised_amount_pence: 1000,
          captured_amount_pence: 700,
          provider_order_id: 'ord-auth',
        },
      ],
    });
    expect(state.authoritativePaidPence).toBe(700);
  });

  it('OVERPAYMENT — unexplained 982 against 716 fare blocks the invoice', () => {
    const state = resolveTripInvoicePaymentState({
      trip: cardTrip({ final_fare_pence: 716 }),
      paymentSessions: [
        { trip_id: 'trip-a', status: 'captured', captured_amount_pence: 982, provider_order_id: 'ord-over' },
      ],
    });
    expect(state.paymentClassification).toBe('RECONCILIATION_REQUIRED');
    expect(state.invoiceEligible).toBe(false);
    expect(isInvoiceEmailAllowed(state)).toBe(false);
  });

  it('FAILED — no capture evidence blocks the invoice even with a mirror row', () => {
    const state = resolveTripInvoicePaymentState({
      trip: cardTrip({ final_fare_pence: 716, payment_status: 'capture_failed' }),
      paymentSessions: [
        { trip_id: 'trip-a', status: 'capture_failed', captured_amount_pence: 0, authorised_amount_pence: 716 },
      ],
      payments: [{ id: 'pay-f', trip_id: 'trip-a', status: 'failed', captured_amount_pence: 0 }],
    });
    expect(state.authoritativePaidPence).toBe(0);
    expect(state.paymentClassification).toBe('PAYMENT_FAILED');
    expect(isInvoiceEmailAllowed(state)).toBe(false);
  });

  it('STACKED — mirrored evidence for two trips never bleeds', () => {
    const sessions = [
      { trip_id: 'trip-a', status: 'captured', captured_amount_pence: 716, provider_order_id: 'ord-a' },
      { trip_id: 'trip-b', status: 'captured', captured_amount_pence: 450, provider_order_id: 'ord-b' },
    ];
    const paymentsRows = [
      { id: 'pa', trip_id: 'trip-a', status: 'captured', captured_amount_pence: 716 },
      { id: 'pb', trip_id: 'trip-b', status: 'captured', captured_amount_pence: 450 },
    ];
    const a = resolveTripInvoicePaymentState({
      trip: cardTrip({ id: 'trip-a', final_fare_pence: 716 }),
      paymentSessions: sessions,
      payments: paymentsRows,
    });
    const b = resolveTripInvoicePaymentState({
      trip: cardTrip({ id: 'trip-b', final_fare_pence: 450 }),
      paymentSessions: sessions,
      payments: paymentsRows,
    });
    expect(a.authoritativePaidPence).toBe(716);
    expect(b.authoritativePaidPence).toBe(450);
  });
});

describe('deterministic provider identity linking', () => {
  it('payments.provider_order_id matching the session order id is one capture', () => {
    const state = resolveTripInvoicePaymentState({
      trip: cardTrip({ final_fare_pence: 716 }),
      paymentSessions: [
        {
          trip_id: 'trip-a',
          status: 'trip_created',
          provider_state: 'COMPLETED',
          captured_amount_pence: 982,
          refunded_amount_pence: 266,
          provider_order_id: '6a80b18b-ac52',
        },
      ],
      payments: [
        {
          id: 'pay-1',
          trip_id: 'trip-a',
          status: 'partially_refunded',
          captured_amount_pence: 982,
          provider_order_id: '6a80b18b-ac52',
        },
      ],
    });
    expect(state.authoritativePaidPence).toBe(716);
    expect(state.providerTransactionIds).toEqual(['6a80b18b-ac52']);
  });

  it('a different provider order id is treated as an independent capture', () => {
    const state = resolveTripInvoicePaymentState({
      trip: cardTrip({ final_fare_pence: 700 }),
      paymentSessions: [
        { trip_id: 'trip-a', status: 'captured', captured_amount_pence: 500, provider_order_id: 'ord-1' },
      ],
      payments: [
        { id: 'p2', trip_id: 'trip-a', status: 'captured', captured_amount_pence: 200, provider_order_id: 'ord-2' },
      ],
    });
    expect(state.authoritativePaidPence).toBe(700);
  });
});
