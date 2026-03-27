import { describe, expect, it } from 'vitest';
import {
  buildTripAccounting,
  validateTripAccounting,
} from '../../supabase/functions/_shared/tripAccounting';

describe('Trip accounting invariants', () => {
  it('keeps driver_net_pence exclusive of tips', () => {
    const result = buildTripAccounting({
      commissionableSubtotalPence: 2078,
      commissionPence: 270,
      tipAmountPence: 150,
    });

    expect(result.driverNetBeforeTipPence).toBe(1808);
    expect(result.driverTotalEarningsPence).toBe(1958);
    expect(result.finalTripTotalPence).toBe(2228);
    expect(result.driverNetBeforeTipPence + 270).toBe(2078);
  });

  it('accepts valid revenue and commission splits', () => {
    const error = validateTripAccounting({
      commissionableSubtotalPence: 7000,
      commissionPence: 980,
      tipAmountPence: 200,
      driverNetBeforeTipPence: 6020,
      driverTotalEarningsPence: 6220,
      finalTripTotalPence: 7200,
    });

    expect(error).toBeNull();
  });

  it('rejects mismatched tipped totals before they hit reporting', () => {
    const error = validateTripAccounting({
      commissionableSubtotalPence: 7000,
      commissionPence: 980,
      tipAmountPence: 200,
      driverNetBeforeTipPence: 6220,
      driverTotalEarningsPence: 6220,
      finalTripTotalPence: 7200,
    });

    expect(error).toBe('driverNetBeforeTipPence must equal commissionableSubtotalPence - commissionPence');
  });
});