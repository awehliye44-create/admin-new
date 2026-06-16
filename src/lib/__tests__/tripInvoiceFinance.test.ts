import { describe, expect, it } from 'vitest';
import {
  getTripInvoiceDriverNetPence,
  getTripInvoiceSettlementTotalPence,
} from '../tripInvoiceFinance';

const payments = new Map<string, number>([
  ['trip-006', 512],
  ['trip-017', 523],
  ['trip-019', 480],
]);

function ctx(tripId: string) {
  return { paymentCapturedPence: payments.get(tripId) ?? null };
}

describe('tripInvoiceFinance — settlement SSOT for invoice writer', () => {
  it('MK-260615-006: Final Settlement Total £5.12', () => {
    expect(
      getTripInvoiceSettlementTotalPence(
        {
          payment_method: 'card',
          payment_status: 'captured',
          final_fare_pence: 512,
          gross_fare_pence: 480,
          driver_net_pence: 435,
        },
        ctx('trip-006'),
      ),
    ).toBe(512);
    expect(getTripInvoiceDriverNetPence({ driver_net_pence: 435 }, ctx('trip-006'))).toBe(435);
  });

  it('MK-260615-017: Final Settlement Total £5.23', () => {
    expect(
      getTripInvoiceSettlementTotalPence(
        {
          payment_method: 'card',
          payment_status: 'captured',
          final_fare_pence: 523,
          gross_fare_pence: 480,
        },
        ctx('trip-017'),
      ),
    ).toBe(523);
    expect(getTripInvoiceDriverNetPence({ driver_net_pence: 445 }, ctx('trip-017'))).toBe(445);
  });

  it('MK-260615-004: cash Final Settlement Total £7.93', () => {
    expect(
      getTripInvoiceSettlementTotalPence({
        payment_method: 'cash',
        payment_status: 'collected_cash',
        final_fare_pence: 793,
        gross_fare_pence: 793,
        driver_net_pence: 687,
      }),
    ).toBe(793);
    expect(getTripInvoiceDriverNetPence({ driver_net_pence: 687 })).toBe(687);
  });

  it('MK-260615-019: Final Settlement Total £4.80', () => {
    expect(
      getTripInvoiceSettlementTotalPence(
        {
          payment_method: 'card',
          payment_status: 'captured',
          final_fare_pence: 480,
          gross_fare_pence: 480,
        },
        ctx('trip-019'),
      ),
    ).toBe(480);
    expect(getTripInvoiceDriverNetPence({ driver_net_pence: 408 }, ctx('trip-019'))).toBe(408);
  });

  it('never uses gross_fare_pence when card captured differs', () => {
    const total = getTripInvoiceSettlementTotalPence(
      {
        payment_method: 'card',
        payment_status: 'captured',
        final_fare_pence: 512,
        gross_fare_pence: 528,
      },
      { paymentCapturedPence: 512 },
    );
    expect(total).toBe(512);
    expect(total).not.toBe(528);
  });
});
