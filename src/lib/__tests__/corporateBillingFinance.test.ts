import { describe, expect, it } from 'vitest';
import { enrichCorporateReportTrip } from '../corporateReportFinance';
import {
  formatDriverNetPence,
  getQuotedContractFareMajor,
  sumCompletedCustomerPaidPence,
} from '../corporateBillingFinance';

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

const fmt = (amount: number) => `£${amount.toFixed(2)}`;

function enrich(id: string, overrides: Record<string, unknown>) {
  return enrichCorporateReportTrip(
    {
      id,
      created_at: '2026-06-15T12:00:00Z',
      status: 'completed',
      ...overrides,
    } as Parameters<typeof enrichCorporateReportTrip>[0],
    payments,
    ledger,
  );
}

describe('corporateBillingFinance — Phase 1D reference trips', () => {
  it('MK-260615-006: customer paid £5.12, driver net £4.35', () => {
    const trip = enrich('trip-006', {
      payment_method: 'card',
      payment_status: 'captured',
      final_fare_pence: 512,
      gross_fare_pence: 480,
      driver_net_pence: 435,
    });
    expect(trip.customerPaidPence).toBe(512);
    expect(trip.driverNetPence).toBe(435);
    expect(formatDriverNetPence(trip.driverNetPence, fmt)).toBe('£4.35');
  });

  it('MK-260615-017: customer paid £5.23, driver net £4.45', () => {
    const trip = enrich('trip-017', {
      payment_method: 'card',
      payment_status: 'captured',
      final_fare_pence: 523,
      gross_fare_pence: 480,
      driver_net_pence: 445,
    });
    expect(trip.customerPaidPence).toBe(523);
    expect(trip.driverNetPence).toBe(445);
  });

  it('MK-260615-004: cash collected £7.93, driver net £6.87', () => {
    const trip = enrich('trip-004', {
      payment_method: 'cash',
      payment_status: 'collected_cash',
      final_fare_pence: 793,
      gross_fare_pence: 793,
      driver_net_pence: 687,
    });
    expect(trip.customerPaidPence).toBe(793);
    expect(trip.driverNetPence).toBe(687);
  });

  it('MK-260615-019: customer paid £4.80, driver net £4.08', () => {
    const trip = enrich('trip-019', {
      payment_method: 'card',
      payment_status: 'captured',
      final_fare_pence: 480,
      gross_fare_pence: 480,
      driver_net_pence: 408,
    });
    expect(trip.customerPaidPence).toBe(480);
    expect(trip.driverNetPence).toBe(408);
  });

  it('completed settlement revenue uses customer paid, not gross_fare_pence', () => {
    const trips = [
      enrich('trip-006', {
        payment_method: 'card',
        payment_status: 'captured',
        final_fare_pence: 512,
        gross_fare_pence: 480,
        driver_net_pence: 435,
      }),
    ];
    expect(sumCompletedCustomerPaidPence(trips)).toBe(512);
    expect(sumCompletedCustomerPaidPence(trips)).not.toBe(480);
  });

  it('quoted/contract fare is separate from settlement revenue', () => {
    expect(getQuotedContractFareMajor({ estimated_fare: 6.5, fare: null })).toBe(6.5);
    expect(getQuotedContractFareMajor({ estimated_fare: null, fare: 4.8 })).toBe(4.8);
  });

  it('driver net unknown when missing', () => {
    const trip = enrich('trip-missing', {
      payment_method: 'card',
      payment_status: 'captured',
      final_fare_pence: 512,
      gross_fare_pence: 512,
    });
    expect(trip.driverNetPence).toBeNull();
    expect(formatDriverNetPence(trip.driverNetPence, fmt)).toBe('Unknown');
  });
});
