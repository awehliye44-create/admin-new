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
  const ssot = read('supabase/functions/_shared/frDriverReconciliationSSOT.ts');

  it('renames period payable columns and does not use ambiguous live labels as period truth', () => {
    expect(panel).toContain('Period Expected Driver Payable');
    expect(panel).toContain('Period TEN Credits');
    expect(panel).toContain('Period Payable Variance');
    expect(panel).toContain('Live Wallet Balance');
    expect(panel).toContain('Live Available for Payout');
    expect(panel).not.toContain('>Expected Driver Payable<');
    expect(panel).not.toContain('>Actual Wallet Trip Credits<');
    expect(panel).not.toContain('>Current Wallet Balance<');
  });

  it('surfaces pending/post-payout tooltip', () => {
    expect(panel).toContain(
      'Pending 27h credits and post-payout credits are not payout mismatches.',
    );
  });

  it('overview separates period payable from live ledger balance', () => {
    expect(overview).toContain('Period driver payable (SSOT)');
    expect(overview).toContain('Ledger wallet balance (live)');
    expect(overview).toContain('not compared to period payable for status');
  });

  it('SSOT period payable variance excludes payout debits by construction', () => {
    expect(ssot).toContain('periodPayableVariancePence');
    expect(ssot).toContain('Payout / cashout / fee debits must not enter this comparison');
    expect(ssot).toContain('frReconciliationStatusIgnoresLiveWalletBalance');
  });
});
