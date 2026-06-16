import { describe, expect, it } from 'vitest';
import {
  getExpectedCustomerTotalPence,
  getTripCaptureStatus,
  getTripDriverNetPence,
  getTripSettlementBreakdown,
  getTripSettlementFarePence,
  summarizeTripPayments,
  type TripCaptureFields,
} from '../tripCaptureStatus';

/** Prod snapshot fields for screenshot trips (thazislrdkjpvvghtvzo, 2026-06-08). */
const PROD_TRIPS: Record<string, TripCaptureFields> = {
  'MK-260608-003': {
    payment_method: 'card',
    payment_status: 'captured',
    final_fare_pence: 562,
    final_customer_fare_pence: 541,
    gross_fare_pence: 562,
    capture_amount_pence: 562,
    tip_pence: 0,
    payment_captured_pence: 562,
    payment_count: 1,
    has_shortfall_payment_intent: false,
  },
  'MK-260608-001': {
    payment_method: 'card',
    payment_status: 'captured',
    final_fare_pence: 627,
    final_customer_fare_pence: 627,
    gross_fare_pence: 627,
    capture_amount_pence: 727,
    tip_pence: 100,
    payment_captured_pence: 727,
    payment_tip_pence: 100,
    payment_count: 1,
    has_shortfall_payment_intent: false,
  },
  'MK-260607-014': {
    payment_method: 'card',
    payment_status: 'captured',
    final_fare_pence: 611,
    final_customer_fare_pence: 563,
    gross_fare_pence: 611,
    capture_amount_pence: 348,
    tip_pence: 500,
    payment_captured_pence: 1111,
    payment_tip_pence: 500,
    payment_count: 1,
    has_shortfall_payment_intent: true,
  },
  'MK-260607-011': {
    payment_method: 'card',
    payment_status: 'captured',
    final_fare_pence: 945,
    final_customer_fare_pence: 945,
    gross_fare_pence: 945,
    capture_amount_pence: 1045,
    tip_pence: 100,
    payment_captured_pence: 1045,
    payment_tip_pence: 100,
    payment_count: 1,
    has_shortfall_payment_intent: false,
  },
};

describe('tripCaptureStatus — prod screenshot trips', () => {
  it('MK-260608-003 uses captured settlement fare (includes waiting), not discounted display fare', () => {
    const trip = PROD_TRIPS['MK-260608-003'];
    expect(getTripSettlementFarePence(trip)).toBe(562);
    expect(getExpectedCustomerTotalPence(trip)).toBe(562);
    expect(getTripCaptureStatus(trip).kind).toBe('captured');
    expect(getTripCaptureStatus(trip).shortLabel).toBe('Captured ✓');
  });

  it('MK-260608-001 reconciles fare + tip', () => {
    const trip = PROD_TRIPS['MK-260608-001'];
    expect(getExpectedCustomerTotalPence(trip)).toBe(727);
    expect(getTripCaptureStatus(trip).kind).toBe('captured');
  });

  it('MK-260607-014 treats shortfall PI as split capture at full settlement total', () => {
    const trip = PROD_TRIPS['MK-260607-014'];
    expect(getExpectedCustomerTotalPence(trip)).toBe(1111);
    const status = getTripCaptureStatus(trip);
    expect(status.kind).toBe('captured_split');
    expect(status.shortLabel).toBe('Captured (split) ✓');
    expect(status.paymentCount).toBe(2);
    expect(status.tooltip).toContain('shortfall PI');
  });

  it('MK-260607-011 reconciles fare + tip', () => {
    const trip = PROD_TRIPS['MK-260607-011'];
    expect(getExpectedCustomerTotalPence(trip)).toBe(1045);
    expect(getTripCaptureStatus(trip).kind).toBe('captured');
  });

  it('legacy post-capture tip metadata counts toward captured total (MK-260613-029 class)', () => {
    const summary = summarizeTripPayments([{
      captured_amount_pence: 734,
      amount_pence: 834,
      status: 'capture_failed',
      metadata: { post_capture_tip_pence: 100, tip_pence: 100 },
    }]);
    expect(summary.capturedTotalPence).toBe(834);

    const trip: TripCaptureFields = {
      payment_method: 'card',
      payment_status: 'capture_failed',
      final_fare_pence: 734,
      tip_pence: 100,
      payment_captured_pence: summary.capturedTotalPence,
      payment_count: 1,
    };
    expect(getTripCaptureStatus(trip).kind).toBe('captured');
  });

  it('never flags mismatch when captured meets or exceeds expected', () => {
    for (const [code, trip] of Object.entries(PROD_TRIPS)) {
      const status = getTripCaptureStatus(trip);
      expect(status.kind, `${code} should not be capture_mismatch`).not.toBe('capture_mismatch');
    }
  });
});

describe('tripCaptureStatus — mismatch gating', () => {
  it('reports mismatch only for genuine under-capture', () => {
    const status = getTripCaptureStatus({
      payment_method: 'card',
      payment_status: 'captured',
      final_fare_pence: 1000,
      tip_pence: 0,
      payment_captured_pence: 900,
      payment_count: 1,
    });
    expect(status.kind).toBe('capture_mismatch');
  });

  it('does not report mismatch when captured exceeds expected (over-capture)', () => {
    const status = getTripCaptureStatus({
      payment_method: 'card',
      payment_status: 'captured',
      final_fare_pence: 1000,
      tip_pence: 0,
      payment_captured_pence: 1050,
      payment_count: 1,
    });
    expect(status.kind).toBe('captured');
  });

  it('includes arrival cancellation fee in expected total', () => {
    const trip: TripCaptureFields = {
      payment_method: 'card',
      payment_status: 'captured',
      final_fare_pence: 0,
      tip_pence: 0,
      arrival_cancellation_applied: true,
      arrival_cancellation_fee: 400,
      payment_captured_pence: 400,
      payment_count: 1,
    };
    expect(getExpectedCustomerTotalPence(trip)).toBe(400);
    expect(getTripCaptureStatus(trip).kind).toBe('captured');
  });
});

describe('tripCaptureStatus — Trip History finance SSOT', () => {
  it('card captured: uses captured_amount_pence not legacy final_customer_fare_pence (MK-260615-006 class)', () => {
    const trip: TripCaptureFields = {
      payment_method: 'card',
      payment_status: 'captured',
      final_customer_fare_pence: 480,
      final_fare_pence: 512,
      gross_fare_pence: 512,
      payment_captured_pence: 512,
      payment_count: 1,
    };
    expect(getTripSettlementFarePence(trip)).toBe(512);
    expect(getTripSettlementFarePence(trip) / 100).toBe(5.12);
  });

  it('card captured: driver net from trips.driver_net_pence, not recomputed from captured fare', () => {
    const trip: TripCaptureFields = {
      payment_method: 'card',
      payment_status: 'captured',
      final_customer_fare_pence: 480,
      payment_captured_pence: 512,
      driver_net_pence: 403,
      commission_pence: 77,
      payment_count: 1,
    };
    expect(getTripDriverNetPence(trip)).toBe(403);
    expect(getTripDriverNetPence(trip)).not.toBe(512 - 77);
  });

  it('card captured: prefers ledger TRIP_EARNING_NET over trips.driver_net_pence', () => {
    const trip: TripCaptureFields = {
      payment_method: 'card',
      payment_status: 'captured',
      payment_captured_pence: 512,
      driver_net_pence: 403,
      ledger_trip_earning_net_pence: 435,
      payment_count: 1,
    };
    expect(getTripDriverNetPence(trip)).toBe(435);
  });

  it('cash trip: uses final_fare_pence / collected cash fare', () => {
    const trip: TripCaptureFields = {
      payment_method: 'cash',
      payment_status: 'collected_cash',
      final_fare_pence: 850,
      final_customer_fare_pence: 800,
      driver_net_pence: 680,
    };
    expect(getTripSettlementFarePence(trip)).toBe(850);
    expect(getTripDriverNetPence(trip)).toBe(680);
  });

  it('average fare uses settlement fare: captured 512 not legacy 480', () => {
    const trips: TripCaptureFields[] = [
      {
        payment_method: 'card',
        payment_status: 'captured',
        final_customer_fare_pence: 480,
        payment_captured_pence: 512,
        payment_count: 1,
      },
      {
        payment_method: 'card',
        payment_status: 'captured',
        final_customer_fare_pence: 400,
        payment_captured_pence: 400,
        payment_count: 1,
      },
    ];
    const sum = trips.reduce((s, t) => s + getTripSettlementFarePence(t), 0);
    expect(sum / trips.length).toBe(456);
  });

  it('waiting time included in settlement breakdown when settlement exceeds base', () => {
    const trip: TripCaptureFields = {
      payment_method: 'card',
      payment_status: 'captured',
      final_customer_fare_pence: 480,
      final_fare_pence: 512,
      payment_captured_pence: 512,
      total_waiting_charge_pence: 32,
      payment_count: 1,
    };
    const breakdown = getTripSettlementBreakdown(trip);
    expect(breakdown.totalSettlementPence).toBe(512);
    expect(breakdown.waitingPence).toBe(32);
    expect(breakdown.showBreakdown).toBe(true);
  });

  it('MK-260615-006 prod snapshot: £5.12 customer paid, £4.35 driver net', () => {
    const trip: TripCaptureFields = {
      payment_method: 'card',
      payment_status: 'captured',
      final_customer_fare_pence: 480,
      final_fare_pence: 512,
      gross_fare_pence: 512,
      driver_net_pence: 435,
      payment_captured_pence: 512,
      payment_count: 1,
    };
    expect(getTripSettlementFarePence(trip)).toBe(512);
    expect(getTripDriverNetPence(trip)).toBe(435);
  });

  it('missing driver net: returns null, not fare − commission', () => {
    const trip: TripCaptureFields = {
      payment_method: 'card',
      payment_status: 'captured',
      payment_captured_pence: 512,
      commission_pence: 77,
      payment_count: 1,
    };
    expect(getTripDriverNetPence(trip)).toBeNull();
    expect(getTripDriverNetPence(trip)).not.toBe(512 - 77);
  });
});
