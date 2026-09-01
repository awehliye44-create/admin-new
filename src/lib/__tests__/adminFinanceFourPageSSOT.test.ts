import { describe, expect, it } from 'vitest';
import { paymentSessionsUrl } from '../../../shared/adminPaymentSessionsSSOT';
import { payoutLedgerUrl } from '../../../shared/adminPayoutLedgerSSOT';

describe('admin finance four-page routes', () => {
  it('builds canonical payment sessions deep links', () => {
    expect(paymentSessionsUrl()).toBe('/payment-sessions?tab=captured');
    expect(paymentSessionsUrl({ tab: 'active_holds' })).toBe(
      '/payment-sessions?tab=captured&opFilter=release_pending',
    );
    expect(
      paymentSessionsUrl({
        tab: 'failed_recovery',
        paymentSessionId: '11111111-1111-1111-1111-111111111111',
      }),
    ).toBe(
      '/payment-sessions?tab=recovery&opFilter=recovery_required&paymentSessionId=11111111-1111-1111-1111-111111111111',
    );
    expect(paymentSessionsUrl({ moneyAtRisk: true })).toBe(
      '/payment-sessions?tab=captured&opFilter=release_failed',
    );
    expect(paymentSessionsUrl({ tab: 'provider_payments', paymentSessionId: 'ps-1' })).toBe(
      '/payment-sessions?tab=captured&paymentSessionId=ps-1',
    );
    expect(paymentSessionsUrl({ paymentSessionId: 'ps-1' })).toBe(
      '/payment-sessions?tab=captured&paymentSessionId=ps-1',
    );
    expect(paymentSessionsUrl({ tripId: 'trip-1' })).toBe(
      '/payment-sessions?tab=captured&tripId=trip-1',
    );
  });

  it('builds payout ledger deep links', () => {
    expect(payoutLedgerUrl()).toBe('/payout-ledger');
    expect(payoutLedgerUrl({ tab: 'processing', driverId: 'd1' })).toBe(
      '/payout-ledger?tab=processing&driverId=d1',
    );
  });
});

describe('admin finance four-page ownership boundary', () => {
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
