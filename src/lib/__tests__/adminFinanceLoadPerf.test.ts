import { describe, expect, it, vi } from 'vitest';
import {
  ADMIN_FINANCE_QUERY_DEFAULTS,
  ADMIN_FINANCE_SLOW_SECTION_MS,
  ADMIN_FINANCE_SUMMARY_STALE_MS,
  adminFinanceSlowSectionMessage,
  logAdminFinanceQueryTiming,
  withAdminFinanceQueryTiming,
} from '../adminFinanceLoadPerf';

describe('adminFinanceLoadPerf SSOT', () => {
  it('uses 30–60s staleTime and disables window-focus refetch', () => {
    expect(ADMIN_FINANCE_SUMMARY_STALE_MS).toBeGreaterThanOrEqual(30_000);
    expect(ADMIN_FINANCE_SUMMARY_STALE_MS).toBeLessThanOrEqual(60_000);
    expect(ADMIN_FINANCE_QUERY_DEFAULTS.refetchOnWindowFocus).toBe(false);
    expect(ADMIN_FINANCE_SLOW_SECTION_MS).toBeGreaterThanOrEqual(8_000);
    expect(ADMIN_FINANCE_SLOW_SECTION_MS).toBeLessThanOrEqual(10_000);
  });

  it('names the slow section without implying payment failure', () => {
    const msg = adminFinanceSlowSectionMessage('reconciliation audit');
    expect(msg).toMatch(/reconciliation audit/i);
    expect(msg.toLowerCase()).not.toMatch(/payment broken|risk|failed capture/);
  });

  it('logs timing without secrets', async () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    await withAdminFinanceQueryTiming(
      {
        page: 'payment_sessions',
        tab: 'overview',
        query_name: 'list',
        rowCount: () => 3,
      },
      async () => ({ rows: [1, 2, 3] }),
    );
    expect(spy).toHaveBeenCalled();
    const payload = spy.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload.event).toBe('ADMIN_FINANCE_QUERY_TIMING');
    expect(payload.query_name).toBe('list');
    expect(payload.row_count).toBe(3);
    expect(JSON.stringify(payload)).not.toMatch(/card|pan|cvv|secret|token/i);
    spy.mockRestore();
  });

  it('records failed timings', async () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    await expect(
      withAdminFinanceQueryTiming(
        { page: 'payout_ledger', query_name: 'overview' },
        async () => {
          throw new Error('boom');
        },
      ),
    ).rejects.toThrow('boom');
    const payload = spy.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload.ok).toBe(false);
    spy.mockRestore();
  });

  it('exposes direct timing logger', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    logAdminFinanceQueryTiming({
      page: 'driver_wallet_ledger',
      query_name: 'fleet',
      duration_ms: 120,
      row_count: 10,
      ok: true,
    });
    expect(spy).toHaveBeenCalledWith(
      'ADMIN_FINANCE_QUERY_TIMING',
      expect.objectContaining({ duration_ms: 120, row_count: 10 }),
    );
    spy.mockRestore();
  });
});
