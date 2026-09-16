import { describe, expect, it } from 'vitest';
import { deriveFeeDisplay } from '../../../shared/paymentSessionsDisplaySSOT';

describe('Payment Sessions provider fee evidence', () => {
  it('shows a provider-confirmed fee as actual', () => {
    expect(deriveFeeDisplay({
      provider_processing_fee_pence: 25,
      fee_status: 'ACTUAL',
    })).toEqual({ label: 'ACTUAL', badge: 'ACTUAL', amount_pence: 25 });
  });

  it('labels estimates instead of presenting them as actual', () => {
    expect(deriveFeeDisplay({
      provider_processing_fee_pence: 25,
      fee_status: 'ESTIMATED',
    })).toEqual({ label: 'ESTIMATED', badge: 'ESTIMATED', amount_pence: 25 });
  });

  it('does not present an unclassified stored amount as an actual provider fee', () => {
    expect(deriveFeeDisplay({
      provider_processing_fee_pence: 25,
      fee_status: null,
    })).toEqual({ label: 'Pending provider fee', badge: 'PENDING', amount_pence: null });
  });
});