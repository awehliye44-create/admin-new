import { describe, expect, it } from 'vitest';
import {
  calculateMonthlySettlementTrends,
  enrichCorporateReportTrip,
  isCountableCorporateFinancialTrip,
  sumCustomerPaidPence,
  sumDriverNetPence,
} from '../corporateReportFinance';

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

describe('corporateReportFinance — Phase 1D reference trips', () => {
  it('MK-260615-006: settlement revenue £5.12, driver net £4.35', () => {
    const enriched = enrichCorporateReportTrip(
      {
        id: 'trip-006',
        created_at: '2026-06-15T16:31:00Z',
        financial_outcome: 'COMPLETED',
        payment_method: 'card',
        payment_status: 'captured',
        final_fare_pence: 512,
        gross_fare_pence: 480,
        driver_net_pence: 435,
      },
      payments,
      ledger,
    );
    expect(enriched.customerPaidPence).toBe(512);
    expect(enriched.driverNetPence).toBe(435);
  });

  it('MK-260615-017: settlement revenue £5.23, driver net £4.45', () => {
    const enriched = enrichCorporateReportTrip(
      {
        id: 'trip-017',
        created_at: '2026-06-15T18:00:00Z',
        financial_outcome: 'COMPLETED',
        payment_method: 'card',
        payment_status: 'captured',
        final_fare_pence: 523,
        gross_fare_pence: 480,
        driver_net_pence: 445,
      },
      payments,
      ledger,
    );
    expect(enriched.customerPaidPence).toBe(523);
    expect(enriched.driverNetPence).toBe(445);
  });

  it('MK-260615-004: cash collected £7.93, driver net £6.87', () => {
    const enriched = enrichCorporateReportTrip(
      {
        id: 'trip-004',
        created_at: '2026-06-15T12:00:00Z',
        financial_outcome: 'COMPLETED',
        payment_method: 'cash',
        payment_status: 'collected_cash',
        final_fare_pence: 793,
        gross_fare_pence: 793,
        driver_net_pence: 687,
      },
      payments,
      ledger,
    );
    expect(enriched.customerPaidPence).toBe(793);
    expect(enriched.driverNetPence).toBe(687);
  });

  it('MK-260615-019: settlement revenue £4.80, driver net £4.08', () => {
    const enriched = enrichCorporateReportTrip(
      {
        id: 'trip-019',
        created_at: '2026-06-15T20:00:00Z',
        financial_outcome: 'COMPLETED',
        payment_method: 'card',
        payment_status: 'captured',
        final_fare_pence: 480,
        gross_fare_pence: 480,
        driver_net_pence: 408,
      },
      payments,
      ledger,
    );
    expect(enriched.customerPaidPence).toBe(480);
    expect(enriched.driverNetPence).toBe(408);
  });

  it('monthly trends use customer paid, not gross_fare_pence', () => {
    const trips = [
      enrichCorporateReportTrip(
        {
          id: 'trip-006',
          created_at: '2026-06-15T16:31:00Z',
          financial_outcome: 'COMPLETED',
          payment_method: 'card',
          payment_status: 'captured',
          final_fare_pence: 512,
          gross_fare_pence: 480,
          driver_net_pence: 435,
        },
        payments,
        ledger,
      ),
    ];
    const trends = calculateMonthlySettlementTrends(trips);
    expect(trends).toHaveLength(1);
    expect(trends[0].revenue).toBe(5.12);
    expect(trends[0].revenue).not.toBe(4.8);
  });

  it('aggregates settlement revenue and driver net', () => {
    const trips = [
      enrichCorporateReportTrip(
        {
          id: 'trip-006',
          created_at: '2026-06-15T16:31:00Z',
          financial_outcome: 'COMPLETED',
          payment_method: 'card',
          payment_status: 'captured',
          final_fare_pence: 512,
          gross_fare_pence: 480,
          driver_net_pence: 435,
        },
        payments,
        ledger,
      ),
      enrichCorporateReportTrip(
        {
          id: 'trip-019',
          created_at: '2026-06-15T20:00:00Z',
          financial_outcome: 'COMPLETED',
          payment_method: 'card',
          payment_status: 'captured',
          final_fare_pence: 480,
          gross_fare_pence: 480,
          driver_net_pence: 408,
        },
        payments,
        ledger,
      ),
    ];
    expect(sumCustomerPaidPence(trips)).toBe(992);
    expect(sumDriverNetPence(trips)).toBe(843);
  });

  it('does not invent driver net when missing', () => {
    const enriched = enrichCorporateReportTrip(
      {
        id: 'trip-missing',
        created_at: '2026-06-15T16:31:00Z',
        financial_outcome: 'COMPLETED',
        payment_method: 'card',
        payment_status: 'captured',
        final_fare_pence: 512,
        gross_fare_pence: 512,
      },
      new Map([['trip-missing', 512]]),
      new Map(),
    );
    expect(enriched.driverNetPence).toBeNull();
    expect(sumDriverNetPence([enriched])).toBeNull();
  });

  it('filters countable financial outcomes', () => {
    expect(isCountableCorporateFinancialTrip({ id: 'a', created_at: '', financial_outcome: 'COMPLETED' })).toBe(true);
    expect(isCountableCorporateFinancialTrip({ id: 'b', created_at: '', financial_outcome: 'CANCELLED' })).toBe(false);
  });
});
