import { describe, expect, it } from 'vitest';
import {
  TRIP_FINANCE_EXPORT_HEADERS,
  buildTripFinanceExportCsvDocument,
  buildTripFinanceExportRow,
} from '../financeTripExportCsv';

const payments = new Map<string, number>([
  ['trip-006', 512],
  ['trip-017', 523],
  ['trip-019', 480],
]);

const ledger = new Map<string, number>([
  ['trip-006', 435],
  ['trip-017', 445],
  ['trip-004', 687],
  ['trip-019', 408],
]);

function ctx(tripId: string) {
  return {
    paymentCapturedPence: payments.get(tripId) ?? null,
    ledgerTripEarningNetPence: ledger.get(tripId) ?? null,
  };
}

describe('financeTripExportCsv — SSOT reference trips', () => {
  it('headers use Customer Paid and Driver Net, not Gross Fare', () => {
    expect(TRIP_FINANCE_EXPORT_HEADERS).toContain('Customer Paid');
    expect(TRIP_FINANCE_EXPORT_HEADERS).toContain('Driver Net');
    expect(TRIP_FINANCE_EXPORT_HEADERS).not.toContain('Gross Fare');
    expect(TRIP_FINANCE_EXPORT_HEADERS).not.toContain('Gross Revenue');
  });

  it('MK-260615-006: Customer Paid 5.12, Driver Net 4.35', () => {
    const row = buildTripFinanceExportRow(
      {
        payment_method: 'card',
        payment_status: 'captured',
        final_fare_pence: 512,
        gross_fare_pence: 480,
        driver_net_pence: 435,
        commission_pence: 77,
        completed_at: '2026-06-15T16:31:00Z',
      },
      ctx('trip-006'),
      'MK-260615-006',
    );
    expect(row[4]).toBe('5.12');
    expect(row[5]).toBe('4.35');
    expect(row[4]).not.toBe('4.80');
  });

  it('MK-260615-017: Customer Paid 5.23, Driver Net 4.45', () => {
    const row = buildTripFinanceExportRow(
      {
        payment_method: 'card',
        payment_status: 'captured',
        final_fare_pence: 523,
        gross_fare_pence: 480,
        driver_net_pence: 445,
        completed_at: '2026-06-15T18:00:00Z',
      },
      ctx('trip-017'),
      'MK-260615-017',
    );
    expect(row[4]).toBe('5.23');
    expect(row[5]).toBe('4.45');
  });

  it('MK-260615-004: cash Customer Paid 7.93, Driver Net 6.87', () => {
    const row = buildTripFinanceExportRow(
      {
        payment_method: 'cash',
        payment_status: 'collected_cash',
        final_fare_pence: 793,
        gross_fare_pence: 793,
        driver_net_pence: 687,
        completed_at: '2026-06-15T12:00:00Z',
      },
      ctx('trip-004'),
      'MK-260615-004',
    );
    expect(row[4]).toBe('7.93');
    expect(row[5]).toBe('6.87');
  });

  it('MK-260615-019: Customer Paid 4.80, Driver Net 4.08', () => {
    const row = buildTripFinanceExportRow(
      {
        payment_method: 'card',
        payment_status: 'captured',
        final_fare_pence: 480,
        gross_fare_pence: 480,
        driver_net_pence: 408,
        completed_at: '2026-06-15T20:00:00Z',
      },
      ctx('trip-019'),
      'MK-260615-019',
    );
    expect(row[4]).toBe('4.80');
    expect(row[5]).toBe('4.08');
  });

  it('driver net Unknown when missing — never fare minus commission', () => {
    const row = buildTripFinanceExportRow(
      {
        payment_method: 'card',
        payment_status: 'captured',
        final_fare_pence: 512,
        gross_fare_pence: 512,
        commission_pence: 77,
      },
      ctx('trip-006'),
      'MK-260615-006',
    );
    expect(row[5]).toBe('4.35');
    const missing = buildTripFinanceExportRow(
      {
        payment_method: 'card',
        payment_status: 'captured',
        final_fare_pence: 512,
        gross_fare_pence: 512,
        commission_pence: 77,
      },
      { paymentCapturedPence: 512 },
      'MK-test',
    );
    expect(missing[5]).toBe('Unknown');
  });

  it('buildTripFinanceExportCsvDocument includes header row', () => {
    const csv = buildTripFinanceExportCsvDocument([
      buildTripFinanceExportRow(
        {
          payment_method: 'card',
          payment_status: 'captured',
          final_fare_pence: 512,
          driver_net_pence: 435,
        },
        ctx('trip-006'),
        'MK-260615-006',
      ),
    ]);
    expect(csv.split('\n')[0]).toContain('Customer Paid');
    expect(csv).toContain('MK-260615-006');
    expect(csv).toContain('5.12');
  });
});
