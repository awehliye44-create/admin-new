/**
 * FR Drivers tab ownership / labelling lock — period payable ≠ live wallet.
 *
 * Run: npx vitest run src/lib/__tests__/frDriverScopeOwnershipLock.test.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../../..');

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8');
}

describe('FR driver scope ownership UI', () => {
  const panel = read('src/components/finance/DriverWalletSsotPanel.tsx');
  const overview = read('src/components/finance/FinancialReconciliationOverviewTab.tsx');
  const drawer = read('src/components/finance/FinancialReconciliationDriverDrawer.tsx');
  const ssot = read('supabase/functions/_shared/frDriverReconciliationSSOT.ts');

  it('labels period driver columns separately from live available balance', () => {
    expect(panel).toContain('Expected earnings');
    expect(panel).toContain('Wallet credited');
    expect(panel).toContain('Paid out');
    expect(panel).toContain('Available');
    expect(panel).toContain('Live payout eligibility (not period-scoped)');
    expect(panel).toContain('expected_payable_pence');
    expect(panel).toContain('actual_wallet_trip_credits_pence');
    expect(panel).toContain('available_for_payout_pence');
    expect(panel).not.toContain('Live Wallet Balance');
  });

  it('SSOT documents pending/post-payout credits are not payout mismatches', () => {
    expect(ssot).toContain(
      'Pending 27h credits and post-payout credits are not payout mismatches.',
    );
  });

  it('driver drawer surfaces backend reconciliation reasons', () => {
    expect(drawer).toContain('reconciliation_reasons');
  });

  it('overview uses period summary cards without live wallet balance KPIs', () => {
    expect(overview).toContain('Driver earnings');
    expect(overview).toContain('Period trip stamps');
    expect(overview).not.toContain('Ledger wallet balance (live)');
    expect(overview).not.toContain('Live Available for Payout');
  });

  it('SSOT period payable variance excludes payout debits by construction', () => {
    expect(ssot).toContain('periodPayableVariancePence');
    expect(ssot).toContain('Payout / cashout / fee debits must not enter this comparison');
    expect(ssot).toContain('frReconciliationStatusIgnoresLiveWalletBalance');
  });
});
