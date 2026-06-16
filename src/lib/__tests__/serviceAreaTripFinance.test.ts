import { describe, expect, it } from 'vitest';
import {
  getServiceAreaTripCustomerPaidPence,
  getServiceAreaTripDriverNetPence,
} from '../serviceAreaTripFinance';

describe('serviceAreaTripFinance — Phase 1D reference trips', () => {
  it('MK-260615-006: card captured £5.12, driver net £4.35', () => {
    const trip = {
      payment_method: 'card',
      payment_status: 'captured',
      final_fare_pence: 512,
      gross_fare_pence: 480,
      driver_net_pence: 435,
    };
    expect(
      getServiceAreaTripCustomerPaidPence(trip, { paymentCapturedPence: 512 }),
    ).toBe(512);
    expect(
      getServiceAreaTripDriverNetPence(trip, { paymentCapturedPence: 512 }),
    ).toBe(435);
  });

  it('MK-260615-017: card captured £5.23, driver net £4.45', () => {
    const trip = {
      payment_method: 'card',
      payment_status: 'captured',
      final_fare_pence: 523,
      gross_fare_pence: 480,
      driver_net_pence: 445,
    };
    expect(
      getServiceAreaTripCustomerPaidPence(trip, { paymentCapturedPence: 523 }),
    ).toBe(523);
    expect(
      getServiceAreaTripDriverNetPence(trip, { paymentCapturedPence: 523 }),
    ).toBe(445);
  });

  it('MK-260615-004: cash collected £7.93, driver net £6.87', () => {
    const trip = {
      payment_method: 'cash',
      payment_status: 'collected_cash',
      final_fare_pence: 793,
      gross_fare_pence: 793,
      driver_net_pence: 687,
    };
    expect(getServiceAreaTripCustomerPaidPence(trip)).toBe(793);
    expect(getServiceAreaTripDriverNetPence(trip)).toBe(687);
  });

  it('MK-260615-019: card captured £4.80, driver net £4.08', () => {
    const trip = {
      payment_method: 'card',
      payment_status: 'captured',
      final_fare_pence: 480,
      gross_fare_pence: 480,
      driver_net_pence: 408,
    };
    expect(
      getServiceAreaTripCustomerPaidPence(trip, { paymentCapturedPence: 480 }),
    ).toBe(480);
    expect(
      getServiceAreaTripDriverNetPence(trip, { paymentCapturedPence: 480 }),
    ).toBe(408);
  });

  it('prefers ledger TRIP_EARNING_NET over trips.driver_net_pence', () => {
    const trip = {
      payment_method: 'card',
      payment_status: 'captured',
      final_fare_pence: 512,
      driver_net_pence: 400,
    };
    expect(
      getServiceAreaTripDriverNetPence(trip, {
        paymentCapturedPence: 512,
        ledgerTripEarningNetPence: 435,
      }),
    ).toBe(435);
  });

  it('does not invent driver net from fare − commission', () => {
    const trip = {
      payment_method: 'card',
      payment_status: 'captured',
      final_fare_pence: 512,
      gross_fare_pence: 512,
    };
    expect(
      getServiceAreaTripDriverNetPence(trip, { paymentCapturedPence: 512 }),
    ).toBeNull();
    expect(
      getServiceAreaTripDriverNetPence(trip, { paymentCapturedPence: 512 }),
    ).not.toBe(512 - 77);
  });
});
