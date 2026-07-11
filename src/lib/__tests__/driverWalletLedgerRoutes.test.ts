import { describe, expect, it } from 'vitest';
import { parseDriverWalletLedgerTab, driverWalletLedgerUrl } from '@/lib/driverWalletLedgerRoutes';

describe('driverWalletLedgerRoutes SSOT tabs', () => {
  it('canonicalises legacy slugs to production hard-rule tabs', () => {
    expect(parseDriverWalletLedgerTab('ledger')).toBe('transactions');
    expect(parseDriverWalletLedgerTab('debt')).toBe('debt_recovery');
    expect(parseDriverWalletLedgerTab('payout_allocations')).toBe('overview');
    expect(parseDriverWalletLedgerTab('payouts')).toBe('overview');
    expect(parseDriverWalletLedgerTab('downloads')).toBe('statements');
    expect(parseDriverWalletLedgerTab(null)).toBe('drivers');
  });

  it('keeps canonical tabs stable', () => {
    expect(parseDriverWalletLedgerTab('drivers')).toBe('drivers');
    expect(parseDriverWalletLedgerTab('overview')).toBe('overview');
    expect(parseDriverWalletLedgerTab('settlement')).toBe('settlement');
    expect(parseDriverWalletLedgerTab('transactions')).toBe('transactions');
    expect(parseDriverWalletLedgerTab('debt_recovery')).toBe('debt_recovery');
    expect(parseDriverWalletLedgerTab('statements')).toBe('statements');
  });

  it('builds urls with canonical tab', () => {
    expect(driverWalletLedgerUrl('d1', 'ledger')).toContain('tab=transactions');
    expect(driverWalletLedgerUrl('d1', 'debt')).toContain('tab=debt_recovery');
    expect(driverWalletLedgerUrl('d1', 'overview')).toContain('tab=overview');
  });
});
