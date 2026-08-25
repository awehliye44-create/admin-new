/**
 * Admin finance pages — load/UX performance SSOT (display only).
 * No money math, no Edge ownership changes, no provider calls.
 */

export const ADMIN_FINANCE_SUMMARY_STALE_MS = 45_000;
export const ADMIN_FINANCE_TABLE_STALE_MS = 45_000;
/** Soft “taking longer” banner — not a payment-risk signal. */
export const ADMIN_FINANCE_SLOW_SECTION_MS = 8_000;

export const ADMIN_FINANCE_QUERY_DEFAULTS = {
  staleTime: ADMIN_FINANCE_SUMMARY_STALE_MS,
  refetchOnWindowFocus: false as const,
  refetchOnReconnect: false as const,
};

export type AdminFinanceQueryTiming = {
  page: 'payment_sessions' | 'financial_reconciliation' | 'driver_wallet_ledger' | 'payout_ledger';
  tab?: string | null;
  query_name: string;
  duration_ms: number;
  row_count?: number | null;
  ok: boolean;
};

/** Safe console timing — no secrets, cards, or PII. */
export function logAdminFinanceQueryTiming(input: AdminFinanceQueryTiming): void {
  const payload = {
    event: 'ADMIN_FINANCE_QUERY_TIMING',
    page: input.page,
    tab: input.tab ?? null,
    query_name: input.query_name,
    duration_ms: Math.round(input.duration_ms),
    row_count: input.row_count ?? null,
    ok: input.ok,
  };
  console.info('ADMIN_FINANCE_QUERY_TIMING', payload);
}

export async function withAdminFinanceQueryTiming<T>(
  meta: Omit<AdminFinanceQueryTiming, 'duration_ms' | 'ok' | 'row_count'> & {
    rowCount?: (result: T) => number | null | undefined;
  },
  fn: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  try {
    const result = await fn();
    logAdminFinanceQueryTiming({
      page: meta.page,
      tab: meta.tab,
      query_name: meta.query_name,
      duration_ms: Date.now() - started,
      row_count: meta.rowCount?.(result) ?? null,
      ok: true,
    });
    return result;
  } catch (err) {
    logAdminFinanceQueryTiming({
      page: meta.page,
      tab: meta.tab,
      query_name: meta.query_name,
      duration_ms: Date.now() - started,
      row_count: null,
      ok: false,
    });
    throw err;
  }
}

export function adminFinanceSlowSectionMessage(sectionLabel: string): string {
  const label = sectionLabel.trim() || 'this section';
  return `Loading ${label} is taking longer than usual. Other parts of the page may still be usable.`;
}
