import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tripHistoryStatusLabel } from '../../../shared/adminTripPaymentDispositionSSOT';
import { resolveTripHistoryTerminalOutcomeDisplay } from '../../../shared/tripHistoryTerminalOutcomeDisplaySSOT';
import { belongsInMissedCancelled } from '../adminTripNoShowClassification';
import {
  classifyMissedCancelledBucket,
  excludesQuotedFareImpact,
  missedCancelledQuotedFareImpactPence,
  resolveAdminArrivalCancellationFeePence,
  summarizeMissedCancelledStats,
  type MissedCancelledStatsRow,
} from '../missedCancelledTerminalStats';

/** MK-261002-014 shape: legacy arrival metadata missing, stale normal-ride stamp 500/75/425. */
const MK_261002_014 = {
  id: 'trip-014',
  trip_code: 'MK-261002-014',
  status: 'cancelled',
  financial_outcome: 'ARRIVAL_CANCELLATION',
  financial_model: 'PLATFORM_COLLECTED',
  payment_status: 'fee_charged',
  arrival_cancellation_applied: false,
  arrival_cancellation_fee: null,
  arrival_cancellation_reason: null,
  capture_amount_pence: 450,
  cancellation_fee_pence: 450,
  provider_fee_pence: 24,
  commission_pence: 75,
  driver_net_pence: 425,
  gross_fare_pence: 500,
  final_fare_pence: 500,
  estimated_fare: 5,
  currency_code: 'GBP',
  payment_disposition: {
    payment_session_id: 'ps-014',
    captured_amount_pence: 450,
    released_amount_pence: 300,
    refunded_amount_pence: 0,
    provider_processing_fee_pence: 24,
    fee_status: 'ACTUAL',
    provider_state: 'COMPLETED',
    payment_status: 'captured',
    payment_label: 'Captured',
    amount_label: null,
    amount_pence: 450,
    financial_model: 'PLATFORM_COLLECTED',
    terminal_disposition_reason: 'ARRIVAL_CANCELLATION_FEE',
    is_no_show_outcome: false,
  },
};

const NO_FEE: MissedCancelledStatsRow = {
  id: 'trip-nofee',
  status: 'cancelled',
  financial_outcome: 'CANCELLED_NO_FEE',
  final_fare_pence: 650,
  currency_code: 'GBP',
};

const CANCELLED_NO_OUTCOME: MissedCancelledStatsRow = {
  id: 'trip-legacy',
  status: 'customer_cancelled',
  financial_outcome: null,
  final_fare_pence: 800,
  currency_code: 'GBP',
};

const LEGACY_CAPTURE_NO_KIND: MissedCancelledStatsRow = {
  id: 'trip-legacy-capture',
  status: 'cancelled',
  financial_outcome: 'CANCELLED_WITH_FEE',
  capture_amount_pence: 400,
  final_fare_pence: 700,
  currency_code: 'GBP',
};

const CANCELLED_NO_SHOW: MissedCancelledStatsRow = {
  id: 'trip-noshow',
  status: 'cancelled',
  financial_outcome: 'NO_SHOW',
  no_show_charge_pence: 400,
  cancellation_fee_pence: 400,
  final_fare_pence: 900,
  currency_code: 'GBP',
};

const LATE: MissedCancelledStatsRow = {
  id: 'trip-late',
  status: 'cancelled',
  financial_outcome: 'LATE_PASSENGER_CANCELLATION',
  capture_amount_pence: 300,
  final_fare_pence: 1000,
  currency_code: 'GBP',
};

const EXPIRED: MissedCancelledStatsRow = {
  id: 'trip-expired',
  status: 'expired',
  final_fare_pence: 1200,
  currency_code: 'GBP',
};

describe('MK-261002-014 Admin surfaces', () => {
  it('badge stays Arrival Cancellation with legacy metadata missing', () => {
    expect(tripHistoryStatusLabel(MK_261002_014)).toBe('Arrival Cancellation');
  });

  it('stays in Missed & Cancelled (operational status cancelled)', () => {
    expect(belongsInMissedCancelled(MK_261002_014)).toBe(true);
    expect(classifyMissedCancelledBucket(MK_261002_014)).toBe('ARRIVAL_CANCELLATION');
  });

  it('payment outcome is 450 charged / 24 fee / 426 entitlement / 0 commission', () => {
    const display = resolveTripHistoryTerminalOutcomeDisplay(MK_261002_014);
    expect(display?.outcome_kind).toBe('ARRIVAL_CANCELLATION');
    expect(display?.customer_charge_pence).toBe(450);
    expect(display?.provider_fee_pence).toBe(24);
    expect(display?.driver_entitlement_pence).toBe(426);
    expect(display?.onecab_commission_pence).toBe(0);
    expect(display?.entitlement_pending).toBe(false);
    expect(display?.original_quote_pence).toBe(500);
  });

  it('fee block shows 450 pence from capture even though arrival_cancellation_applied=false', () => {
    expect(resolveAdminArrivalCancellationFeePence(MK_261002_014)).toBe(450);
  });

  it('original £5.00 quote is excluded from the quoted-fare total', () => {
    expect(excludesQuotedFareImpact(MK_261002_014)).toBe(true);
    expect(missedCancelledQuotedFareImpactPence(MK_261002_014)).toBe(0);
  });
});

describe('Arrival fee block amount precedence', () => {
  it('legacy integer-pence fee only supplements when no capture evidence exists', () => {
    expect(resolveAdminArrivalCancellationFeePence({
      status: 'cancelled',
      arrival_cancellation_applied: true,
      arrival_cancellation_reason: 'ARRIVAL_CANCELLATION_FEE',
      arrival_cancellation_fee: 400,
    })).toBe(400);
  });

  it('capture evidence wins over stale legacy fee', () => {
    expect(resolveAdminArrivalCancellationFeePence({
      status: 'cancelled',
      arrival_cancellation_applied: true,
      arrival_cancellation_fee: 4,
      capture_amount_pence: 450,
    })).toBe(450);
  });

  it('non-arrival trips render no fee block', () => {
    expect(resolveAdminArrivalCancellationFeePence(NO_FEE)).toBeNull();
    expect(resolveAdminArrivalCancellationFeePence(CANCELLED_NO_SHOW)).toBeNull();
    expect(resolveAdminArrivalCancellationFeePence(LATE)).toBeNull();
  });
});

describe('Missed & Cancelled stats split', () => {
  const rows = [
    MK_261002_014,
    NO_FEE,
    CANCELLED_NO_OUTCOME,
    LEGACY_CAPTURE_NO_KIND,
    CANCELLED_NO_SHOW,
    LATE,
    EXPIRED,
  ];

  it('each trip lands in exactly one bucket', () => {
    const stats = summarizeMissedCancelledStats(rows);
    expect(stats).toEqual({
      arrival_cancellation: 1,
      no_show: 1,
      late_passenger_cancellation: 1,
      chargeable_total: 3,
      cancelled_no_fee: 3,
      cancelled_legacy_fee_evidence: 1,
      missed_expired: 1,
      total: 7,
    });
    expect(stats.chargeable_total + stats.cancelled_no_fee + stats.missed_expired).toBe(stats.total);
  });

  it('quoted fare total counts only non-chargeable rows', () => {
    const total = rows.reduce((sum, row) => sum + missedCancelledQuotedFareImpactPence(row), 0);
    expect(total).toBe(650 + 800 + 700 + 1200);
  });
});

describe('MissedCancelled page wiring lock', () => {
  const src = readFileSync(resolve(__dirname, '../../pages/MissedCancelled.tsx'), 'utf8');

  it('fee block is gated on canonical kind, not legacy metadata, and formats pence', () => {
    expect(src).toContain('resolveAdminArrivalCancellationFeePence(selectedTrip)');
    expect(src).not.toMatch(/\{selectedTrip\.arrival_cancellation_applied && \(/);
    expect(src).not.toMatch(/arrival_cancellation_fee \?\? 0\)\.toFixed/);
  });

  it('stats and quoted-fare totals use the canonical bucket helper', () => {
    expect(src).toContain('summarizeMissedCancelledStats(statsFareRows)');
    expect(src).toContain('missedCancelledQuotedFareImpactPence(trip, resolveAdminCommittedCustomerFarePence)');
    expect(src).toContain('Arrival Cancellation:');
    expect(src).toContain('No-Show:');
    expect(src).toContain('Late Passenger Cancellation:');
    expect(src).toContain('Cancelled / No Fee');
  });
});
