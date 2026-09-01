import { describe, expect, it } from 'vitest';
import { mergeFinanceReconciliationInvokeExtra } from '@/hooks/financeReconciliationApi';
import {
  ADMIN_FINANCE_QUERY_DEFAULTS,
  ADMIN_FINANCE_SLOW_SECTION_MS,
} from '@/lib/adminFinanceLoadPerf';

describe('admin finance load performance contracts', () => {
  it('summary_only invoke must not force audit_limit=10000', () => {
    const summary = mergeFinanceReconciliationInvokeExtra({ summary_only: '1' });
    expect(summary.summary_only).toBe('1');
    expect(summary.audit_limit).toBeUndefined();

    const profit = mergeFinanceReconciliationInvokeExtra({ profit_ssot: '1' });
    expect(profit.audit_limit).toBeUndefined();
  });

  it('full audit invoke still requests the full trip audit limit', () => {
    const full = mergeFinanceReconciliationInvokeExtra({});
    expect(full.audit_limit).toBe('10000');
  });

  it('finance query defaults disable window-focus refetch and use 30–60s staleTime', () => {
    expect(ADMIN_FINANCE_QUERY_DEFAULTS.refetchOnWindowFocus).toBe(false);
    expect(ADMIN_FINANCE_QUERY_DEFAULTS.staleTime).toBeGreaterThanOrEqual(30_000);
    expect(ADMIN_FINANCE_QUERY_DEFAULTS.staleTime).toBeLessThanOrEqual(60_000);
  });

  it('slow-section banner waits 8–10s (not the 3s critical-button toast)', () => {
    expect(ADMIN_FINANCE_SLOW_SECTION_MS).toBeGreaterThanOrEqual(8_000);
    expect(ADMIN_FINANCE_SLOW_SECTION_MS).toBeLessThanOrEqual(10_000);
  });

  it('payment sessions hook source is DB-first (no default provider refresh)', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(
      resolve(__dirname, '../../hooks/useAdminPaymentSessions.ts'),
      'utf8',
    );
    expect(src).toMatch(/refresh_provider_state:\s*request\.refresh_provider_state\s*===\s*true/);
    expect(src).toMatch(/isPaymentSessionsProviderPollBackendTab/);
  });

  it('FR SSOT does not auto-refetch on visibilitychange', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(
      resolve(__dirname, '../../hooks/useFinancialReconciliationSSOT.ts'),
      'utf8',
    );
    expect(src).not.toMatch(/addEventListener\(\s*['"]visibilitychange['"]/);
    expect(src).toMatch(/auditMode/);
    expect(src).toMatch(/isAuditLoading/);
  });

  it('payout ledger uses finance cache defaults (not staleTime 0 + focus refetch)', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(
      resolve(__dirname, '../../hooks/useAdminPayoutLedger.ts'),
      'utf8',
    );
    expect(src).toMatch(/ADMIN_FINANCE_QUERY_DEFAULTS/);
    expect(src).not.toMatch(/staleTime:\s*0/);
    expect(src).not.toMatch(/refetchOnWindowFocus:\s*true/);
  });
});
