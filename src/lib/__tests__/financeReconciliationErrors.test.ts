import { describe, expect, it } from 'vitest';
import {
  assertDriverStatementTotalsResponse,
  assertFinanceReconciliationSsotResponse,
  classifyFinanceReconciliationError,
} from '@/lib/financeReconciliationErrors';
import { snapshotScopeKey } from '@/lib/financialReconciliationSnapshot';

describe('financeReconciliationErrors', () => {
  it('classifies 401 as session expired', () => {
    const f = classifyFinanceReconciliationError(
      new Error('admin-finance-reconciliation returned 401: Unauthorized'),
    );
    expect(f.kind).toBe('session_expired');
    expect(f.userMessage).toMatch(/sign in again/i);
  });

  it('classifies 403 with permission slug', () => {
    const f = classifyFinanceReconciliationError(
      new Error('admin-finance-reconciliation returned 403: Forbidden'),
    );
    expect(f.kind).toBe('forbidden');
    expect(f.diagnostics).toMatch(/financial-reconciliation/);
  });

  it('classifies 404 as not deployed', () => {
    const f = classifyFinanceReconciliationError(
      new Error('admin-finance-reconciliation returned 404: missing'),
    );
    expect(f.kind).toBe('not_deployed');
  });

  it('classifies orphan stub contract as wrong_contract', () => {
    expect(() =>
      assertFinanceReconciliationSsotResponse({
        success: true,
        provider_only_count: 2,
        revolut_provider_only: [],
        summary: { revolut_orphan_count: 2 },
      }),
    ).toThrow(/wrong contract/i);

    const f = classifyFinanceReconciliationError(
      new Error('admin-finance-reconciliation wrong contract: orphan/provider-only payload'),
    );
    expect(f.kind).toBe('wrong_contract');
  });

  it('accepts SSOT summary payload', () => {
    expect(() =>
      assertFinanceReconciliationSsotResponse({
        finance_reconciliation_summary: { customer_revenue: {} },
      }),
    ).not.toThrow();
  });

  it('accepts the dedicated profit SSOT payload', () => {
    expect(() =>
      assertFinanceReconciliationSsotResponse({
        profit_ssot: {
          platform_net_revenue_pence: 2472,
          expenses_pence: 0,
          profit_before_tax_pence: 2472,
        },
        meta: {
          ssot_version: 'financial_reconciliation_ssot_v5',
          data_source_badge: 'LIVE',
        },
      }),
    ).not.toThrow();
  });

  it('accepts statement_totals payload without FR summary', () => {
    expect(() =>
      assertDriverStatementTotalsResponse({
        period: { from: '2026-10-01', to: '2026-10-31' },
        currency_code: 'GBP',
        driver_statement_totals: [
          {
            driver_id: 'd1',
            gross_earnings_pence: 1000,
            commission_pence: 200,
            net_earnings_pence: 800,
          },
        ],
        meta: { ssot_version: 'financial_reconciliation_ssot_v5', data_source_badge: 'LIVE' },
      }),
    ).not.toThrow();

    expect(() =>
      assertFinanceReconciliationSsotResponse({
        driver_statement_totals: [],
      }),
    ).toThrow(/missing finance_reconciliation_summary or profit_ssot/);

    expect(() =>
      assertDriverStatementTotalsResponse({
        finance_reconciliation_summary: { customer_revenue: {} },
      }),
    ).toThrow(/missing driver_statement_totals/);
  });
});

describe('snapshotScopeKey', () => {
  it('includes service area and date bounds', () => {
    expect(snapshotScopeKey('r1', 'sa1', '2026-07-01', '2026-07-10')).toBe(
      'r1:sa1:2026-07-01:2026-07-10',
    );
  });
});
