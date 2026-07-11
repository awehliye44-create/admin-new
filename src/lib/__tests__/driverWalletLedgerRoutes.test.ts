import { describe, expect, it } from 'vitest';
import { parseDriverWalletLedgerTab, driverWalletLedgerUrl } from '@/lib/driverWalletLedgerRoutes';

describe('driverWalletLedgerRoutes SSOT tabs', () => {
  it('canonicalises legacy slugs to production hard-rule tabs', () => {
    expect(parseDriverWalletLedgerTab('ledger')).toBe('transactions');
    expect(parseDriverWalletLedgerTab('debt')).toBe('debt_recovery');
    expect(parseDriverWalletLedgerTab('payout_allocations')).toBe('payouts');
    expect(parseDriverWalletLedgerTab('adjustments')).toBe('transactions');
    expect(parseDriverWalletLedgerTab('history')).toBe('transactions');
    expect(parseDriverWalletLedgerTab('drivers')).toBe('overview');
  });

  it('keeps canonical tabs stable', () => {
    expect(parseDriverWalletLedgerTab('overview')).toBe('overview');
    expect(parseDriverWalletLedgerTab('transactions')).toBe('transactions');
    expect(parseDriverWalletLedgerTab('payouts')).toBe('payouts');
    expect(parseDriverWalletLedgerTab('debt_recovery')).toBe('debt_recovery');
    expect(parseDriverWalletLedgerTab('statements')).toBe('statements');
    expect(parseDriverWalletLedgerTab('downloads')).toBe('downloads');
  });

  it('builds urls with canonical tab', () => {
    expect(driverWalletLedgerUrl('d1', 'ledger')).toContain('tab=transactions');
    expect(driverWalletLedgerUrl('d1', 'debt')).toContain('tab=debt_recovery');
  });
});
