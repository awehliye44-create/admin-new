/**
 * PLATFORM_COLLECTED payment-layer display lock.
 *
 * Four SSOT surfaces must never paint UNKNOWN money as £0.00, never substitute
 * a different semantic field into Available/Pending/Reserved chips, and never
 * invent tip/entitlement KPIs from missing parts.
 *
 * Surfaces:
 * 1) Financial Reconciliation
 * 2) Payment Sessions
 * 3) Driver Wallet Ledger
 * 4) Payout Ledger
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');

function read(rel: string): string {
  return readFileSync(path.join(root, rel), 'utf8');
}

/** formatNullablePence(x ?? 0) paints unknown as £0.00 — forbidden on money chips. */
const NULLABLE_PENCE_ZERO =
  /formatNullablePence\s*\(\s*[^)]*\?\?\s*0\s*[,)]/;

/** formatNullablePence(p ?? 0) helper pattern. */
const FMT_P_ZERO = /formatNullablePence\s*\(\s*p\s*\?\?\s*0/;

describe('platform collection money display lock', () => {
  it('1. Financial Reconciliation — tips/entitlement never invent £0 from missing KPIs', () => {
    const src = read('components/finance/FinancialReconciliationOverviewTab.tsx');
    expect(src).toContain('driver_tips_total_pence ?? null');
    expect(src).not.toMatch(/driver_tips_total_pence\s*\?\?\s*0/);
    expect(src).toContain('driverFareNet != null && o!.driver_tips_total_pence != null');
    expect(src).not.toMatch(/\(driverFareNet \?\? 0\) \+ \(driverTips \?\? 0\)/);
  });

  it('2. Payment Sessions — summary cards use formatNullablePence without ?? 0', () => {
    const src = read('components/finance/PaymentSessionsSummaryCards.tsx');
    expect(src).toContain('formatNullablePence(p, currencyCode)');
    expect(src).not.toMatch(FMT_P_ZERO);
    expect(src).not.toMatch(NULLABLE_PENCE_ZERO);
    expect(src).toContain('provider_captured_total_pence');
  });

  it('3. Driver Wallet — Available never falls through to cashout_limit; Pending never to period KPI', () => {
    const balances = read('lib/driverWalletSsotBalances.ts');
    expect(balances).toContain('availablePence: minor(row.available_for_payout_pence)');
    expect(balances).toContain('pendingPence: minor(row.pending_balance_pence)');
    expect(balances).not.toMatch(
      /availablePence:\s*minor\(row\.available_for_payout_pence\)\s*\?\?\s*minor\(row\.cashout_limit/,
    );
    expect(balances).not.toContain('period_kpis?.pending_earnings_pence');

    const fleet = read('lib/driverWalletFleetOverviewSSOT.ts');
    expect(fleet).toContain('available_for_payout_pence != null');
    expect(fleet).toContain('pending_balance_pence != null');
    expect(fleet).not.toMatch(/available_for_payout_pence\s*\?\?\s*row\.cashout_limit/);
    expect(fleet).not.toMatch(/pending_balance_pence\s*\?\?\s*row\.period_kpis/);

    const period = read('components/finance/DriverWalletPeriodWidgetCards.tsx');
    expect(period).not.toMatch(FMT_P_ZERO);
    expect(period).toContain('formatNullablePence(p, currencyCode)');

    const ssotPanel = read('components/finance/DriverWalletSsotPanel.tsx');
    expect(ssotPanel).toContain('fmt(row.available_for_payout_pence)');
    expect(ssotPanel).not.toMatch(/available_for_payout_pence\s*\?\?\s*row\.cashout_limit_pence/);
    expect(ssotPanel).not.toMatch(/payout_ledger_completed_pence\s*\?\?\s*0/);
  });

  it('4. Driver Wallet / Payout — Reserved is WIP only (no included_in_payout_batch coalesce)', () => {
    for (const rel of [
      'lib/driverWalletFleetOverviewSSOT.ts',
      'components/finance/DriverWalletActivePositionCards.tsx',
      'components/finance/DriverWalletDriverList.tsx',
    ]) {
      const src = read(rel);
      const reservedSlice = src.includes('function reservedPence')
        ? src.slice(src.indexOf('function reservedPence'), src.indexOf('function reservedPence') + 350)
        : src;
      expect(reservedSlice).not.toContain('included_in_payout_batch_amount_pence');
      expect(reservedSlice).toMatch(/withdrawal_in_progress_pence/);
    }
  });

  it('5. Payout Ledger — accounts table never paints reserved/held unknown as £0 via ?? 0', () => {
    const src = read('pages/PayoutLedger.tsx');
    expect(src).not.toMatch(/formatNullablePence\(row\.reserved_pence\s*\?\?\s*0\)/);
    expect(src).not.toMatch(/formatNullablePence\(row\.held_pence\s*\?\?\s*0\)/);
    expect(src).toContain("held_driver_count ?? '—'");
    expect(src).toContain('Pending (settlement)');
  });

  it('6. Payout Overview — Pending vs Held/Unbacked are separate chips', () => {
    const panel = read('components/finance/PayoutLedgerOverviewPanel.tsx');
    expect(panel).toContain('title="Pending (settlement)"');
    expect(panel).toContain('title="Held / Unbacked"');
    expect(panel).not.toContain('Other Pending / Held');
    expect(panel).toContain('driver_held_or_unbacked_pence');
  });

  it('7. Company transfers — completed company month never defaults unknown to £0', () => {
    const src = read('components/finance/PayoutLedgerCompanyTransfersPanel.tsx');
    expect(src).toContain(
      'kpis?.completed_company_transfers_month_pence ?? null',
    );
    expect(src).not.toMatch(
      /completed_company_transfers_month_pence\s*\?\?\s*0/,
    );
  });

  it('8. Underprotected company funds never paint Before Reserve / Real Available as £0', () => {
    const ssot = read('lib/payoutLedgerLiquidityCardsSSOT.ts');
    const panel = read('components/finance/PayoutLedgerOverviewPanel.tsx');
    expect(ssot).toMatch(/company_funds_underprotected\) return null/);
    expect(ssot).not.toMatch(/company_funds_underprotected\) return 0/);
    expect(panel).toContain('underprotected\n      ? null');
    expect(panel).toContain('underprotectedReason');
  });

  it('9. Batch eligible count never falls through to total_drivers', () => {
    const src = read('pages/PayoutLedger.tsx');
    expect(src).not.toMatch(/eligible_driver_count\s*\?\?\s*b\.total_drivers/);
    expect(src).not.toMatch(/eligible_driver_count\s*\?\?\s*total_drivers/);
    expect(src).toContain("eligible_driver_count ?? '—'");
  });

  it('10. DWL history never coalesces different money semantics', () => {
    const src = read('components/finance/DriverWalletHistorySummary.tsx');
    expect(src).toContain('fmt(driver.verified_wallet_credits_pence)');
    expect(src).toContain('fmt(driver.payout_ledger_completed_pence)');
    expect(src).toContain('fmt(driver.wallet_adjustments_pence)');
    expect(src).not.toMatch(/verified_wallet_credits_pence\s*\?\?\s*kpis/);
    expect(src).not.toMatch(/payout_ledger_completed_pence\s*\?\?\s*driver\.provider_paid/);
    expect(src).not.toMatch(/wallet_adjustments_pence\s*\?\?\s*kpis/);
  });

  it('11. Fleet Pending label matches Payout settlement wording', () => {
    const src = read('components/finance/DriverWalletFleetOverviewCards.tsx');
    expect(src).toContain('Total Pending (settlement)');
    expect(src).not.toMatch(/label="Total Pending"/);
  });
});
