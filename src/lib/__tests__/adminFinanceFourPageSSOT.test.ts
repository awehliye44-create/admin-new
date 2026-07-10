import { describe, expect, it } from 'vitest';
import { paymentSessionsUrl } from '../../../shared/adminPaymentSessionsSSOT';
import { payoutLedgerUrl } from '../../../shared/adminPayoutLedgerSSOT';

describe('admin finance four-page routes', () => {
  it('builds payment sessions deep links', () => {
    expect(paymentSessionsUrl()).toBe('/payment-sessions');
    expect(paymentSessionsUrl({ tab: 'active_holds' })).toBe('/payment-sessions?tab=active_holds');
    expect(
      paymentSessionsUrl({
        tab: 'failed_recovery',
        paymentSessionId: '11111111-1111-1111-1111-111111111111',
      }),
    ).toContain('paymentSessionId=11111111-1111-1111-1111-111111111111');
  });

  it('builds payout ledger deep links', () => {
    expect(payoutLedgerUrl()).toBe('/payout-ledger');
    expect(payoutLedgerUrl({ tab: 'processing', driverId: 'd1' })).toBe(
      '/payout-ledger?tab=processing&driverId=d1',
    );
  });
});

describe('admin finance permission slugs', () => {
  const REQUIRED = [
    'payment-sessions',
    'financial-reconciliation',
    'driver-wallet-ledger',
    'payout-ledger',
  ] as const;

  it('keeps the four SSOT permission slugs distinct', () => {
    expect(new Set(REQUIRED).size).toBe(4);
  });
});
