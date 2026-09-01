import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../..');

function read(rel: string): string {
  return readFileSync(resolve(ROOT, rel), 'utf8');
}

describe('Financial Reconciliation navigation simplification', () => {
  const page = read('src/pages/FinancialReconciliation.tsx');
  const overview = read('src/components/finance/FinancialReconciliationOverviewTab.tsx');

  it('keeps only four top-level tabs', () => {
    expect(page).toContain("'overview'");
    expect(page).toContain("'trips'");
    expect(page).toContain("'drivers'");
    expect(page).toContain("'issues'");
    expect(page).not.toContain("TabsTrigger value=\"mismatches\"");
    expect(page).not.toContain("TabsTrigger value=\"alerts\"");
    expect(page).not.toContain("TabsTrigger value=\"history\"");
  });

  it('loads full audit only for trips and issues', () => {
    expect(page).toContain("new Set(['trips', 'issues'])");
    expect(page).not.toContain('wallet_mismatches');
  });

  it('lazy-mounts overview content', () => {
    expect(page).toContain("frTab === 'overview'");
    expect(page).toContain("frTab === 'drivers'");
    expect(page).toContain("frTab === 'trips'");
    expect(page).toContain("frTab === 'issues'");
  });

  it('redirects legacy driverCreditExceptions param to Issues', () => {
    expect(page).toContain("driverCreditExceptions') === '1'");
    expect(page).toContain('issueFilter=driver_credit');
  });

  it('filters driver credit on Trips tab in place via tripFilter', () => {
    expect(page).toContain('parseFrTripFilter');
    expect(page).toContain("tripFilter === 'driver_credit'");
    expect(page).toContain("mode={tripFilter === 'driver_credit' ? 'driver_credit_exceptions' : 'all'}");
    expect(page).toContain("if (tab !== 'trips')");
    expect(page).toContain("next.delete('tripFilter')");
  });

  it('does not import removed Alerts tab', () => {
    expect(page).not.toContain('FinancialReconciliationAlertsTab');
    expect(page).not.toContain('useFinanceBackendAudit');
  });

  it('uses unified issues tab with filter chips', () => {
    expect(page).toContain('FinancialReconciliationIssuesTab');
    expect(page).toContain('issueFilter');
    expect(page).toContain('resolveLegacyFrTabIssueFilter');
    expect(page).toContain('exportMeta={frAuditExportMeta}');
    expect(read('src/components/finance/FinancialReconciliationIssuesTab.tsx')).toContain(
      'No issues found for this period.',
    );
  });

  it('blocks stale trip audit rows during period or scope transitions', () => {
    expect(page).toContain('isAuditScopeTransition');
    expect(page).toContain('isSummaryScopeTransition');
    expect(read('src/hooks/useFinancialReconciliationSSOT.ts')).toContain('isAuditScopeTransition');
    expect(read('src/hooks/useFinancialReconciliationSSOT.ts')).toContain('isSummaryScopeTransition');
  });

  it('keeps hooks before legacy redirect returns', () => {
    const exportMetaIndex = page.indexOf('const frAuditExportMeta = useMemo');
    const legacyRedirectIndex = page.indexOf("searchParams.get('tab') === 'connect-balance'");
    expect(exportMetaIndex).toBeGreaterThan(-1);
    expect(legacyRedirectIndex).toBeGreaterThan(-1);
    expect(exportMetaIndex).toBeLessThan(legacyRedirectIndex);
  });

  it('normalizes unknown legacy tabs and invalid issue filters', () => {
    expect(page).toContain("return <Navigate to=\"/financial-reconciliation?tab=overview\" replace />");
    expect(page).toContain('rawIssueFilter !== issueFilter');
    expect(page).toContain("rawIssueFilter && frTab !== 'issues'");
    expect(page).toContain("rawIssueFilter === 'all'");
    expect(page).toContain('rawTripFilter');
  });

  it('clears trip deep-link params after drawer opens', () => {
    expect(page).toContain('onInitialTripConsumed={clearRecoverTrip}');
    expect(page).toContain("next.delete('trip')");
    expect(page).toContain("next.delete('tripId')");
    expect(page).toContain("frTab !== 'trips' && (searchParams.get('trip')");
  });

  it('overview shows simplified summary cards only', () => {
    expect(overview).toContain('Captured revenue');
    expect(overview).toContain('Driver earnings');
    expect(overview).toContain('ONECAB commission');
    expect(overview).toContain('Promotion subsidy');
    expect(overview).toContain('Provider fees');
    expect(overview).toContain('Reconciliation difference');
    expect(overview).toContain('Open issues');
    expect(overview).not.toContain('Driver credit exceptions');
    expect(overview).not.toContain('Matched Trips');
    expect(overview).not.toContain('Ledger wallet balance (live)');
  });
});
