import { describe, expect, it } from 'vitest';
import {
  formatAdminCommittedCustomerFare,
  resolveAdminCommittedCustomerFarePence,
  resolveAdminCommittedCustomerFareSource,
} from '@/lib/adminTripCommittedFareDisplay';
import { computeLiveTripFarePreview } from '@/lib/liveTripFareSSOT';

describe('adminTripCommittedFareDisplay', () => {
  it('G. cancelled modified trip uses canonical final, not estimated_fare', () => {
    const trip = {
      final_customer_fare_pence: 699,
      final_fare_pence: 699,
      estimated_fare: 4.5,
      customer_modification_charge_pence: 249,
    };
    expect(resolveAdminCommittedCustomerFarePence(trip)).toBe(699);
    expect(formatAdminCommittedCustomerFare(trip, '£')).toBe('£6.99');
    expect(resolveAdminCommittedCustomerFareSource(trip)).toBe('final_customer_fare_pence');
  });

  it('H. scheduled revised trip uses canonical revised fare', () => {
    const trip = {
      final_customer_fare_pence: 1039,
      estimated_fare: 6.75,
      gross_fare_pence: 1113,
      offer_discount_pence: 74,
    };
    expect(resolveAdminCommittedCustomerFarePence(trip)).toBe(1039);
  });

  it('I. pre-commit scheduled trip falls back to estimated_fare', () => {
    const trip = {
      estimated_fare: 12.5,
      fare: 12.5,
    };
    expect(resolveAdminCommittedCustomerFarePence(trip)).toBe(1250);
    expect(resolveAdminCommittedCustomerFareSource(trip)).toBe('fare_column');
  });

  it('J. same modified trip matches committed fare on list surfaces', () => {
    const trip = {
      final_customer_fare_pence: 1039,
      final_fare_pence: 1039,
      locked_base_fare_pence: 749,
      customer_modification_charge_pence: 364,
      gross_fare_pence: null,
      offer_discount_pence: null,
    };
    const committed = resolveAdminCommittedCustomerFarePence(trip);
    const live = computeLiveTripFarePreview({
      ...trip,
      modification_delta_pence: 364,
    });
    expect(committed).toBe(1039);
    expect(live.current_customer_total_pence).toBe(1039);
  });

  it('E. promo + modification — committed fare once, live preview not inflated', () => {
    const trip = {
      final_customer_fare_pence: 699,
      locked_base_fare_pence: 500,
      customer_modification_charge_pence: 249,
      gross_fare_pence: 699,
      offer_discount_pence: 50,
    };
    expect(resolveAdminCommittedCustomerFarePence(trip)).toBe(699);
    const live = computeLiveTripFarePreview(trip);
    expect(live.current_customer_total_pence).toBe(699);
    expect(live.approved_modification_delta_pence).toBe(0);
  });

  it('F. active waiting adds only legitimate waiting on top of committed fare', () => {
    const live = computeLiveTripFarePreview({
      final_customer_fare_pence: 1039,
      locked_base_fare_pence: 749,
      customer_modification_charge_pence: 364,
      gross_fare_pence: 1113,
      offer_discount_pence: 74,
      pickup_waiting_charge_pence: 120,
      stop_waiting_charge_pence: 80,
    });
    expect(live.current_customer_total_pence).toBe(1239);
  });
});

describe('liveTripFareSSOT admin locks', () => {
  it('A. gross=null + mod +364 + final 1039 → 1039', () => {
    const preview = computeLiveTripFarePreview({
      final_customer_fare_pence: 1039,
      locked_base_fare_pence: 749,
      customer_modification_charge_pence: 364,
      gross_fare_pence: null,
    });
    expect(preview.current_customer_total_pence).toBe(1039);
    expect(preview.approved_modification_delta_pence).toBe(0);
  });

  it('B. gross present + final 1039 → 1039', () => {
    const preview = computeLiveTripFarePreview({
      final_customer_fare_pence: 1039,
      locked_base_fare_pence: 749,
      customer_modification_charge_pence: 364,
      gross_fare_pence: 1113,
      offer_discount_pence: 74,
    });
    expect(preview.current_customer_total_pence).toBe(1039);
  });

  it('C. negative mod −375 + final 413 → 413', () => {
    const preview = computeLiveTripFarePreview({
      final_customer_fare_pence: 413,
      locked_base_fare_pence: 788,
      customer_modification_charge_pence: -375,
      gross_fare_pence: 413,
    });
    expect(preview.current_customer_total_pence).toBe(413);
  });

  it('D. two modifications — committed final only when above locked base', () => {
    const preview = computeLiveTripFarePreview({
      final_customer_fare_pence: 1039,
      locked_base_fare_pence: 749,
      customer_modification_charge_pence: 364,
      gross_fare_pence: 1113,
      offer_discount_pence: 74,
    });
    expect(preview.approved_modification_delta_pence).toBe(0);
    expect(preview.current_customer_total_pence).toBe(1039);
  });
});
