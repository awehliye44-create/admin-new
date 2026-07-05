/** Normalize admin date inputs (`YYYY-MM-DD`) to full-day ISO bounds for finance SSOT queries. */
export function normalizeFinanceReconciliationPeriod(
  from?: string,
  to?: string,
): { from?: string; to?: string } {
  const normalizeStart = (value: string) => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}T00:00:00.000Z`;
    return value;
  };
  const normalizeEnd = (value: string) => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}T23:59:59.999Z`;
    return value;
  };
  return {
    from: from?.trim() ? normalizeStart(from.trim()) : undefined,
    to: to?.trim() ? normalizeEnd(to.trim()) : undefined,
  };
}
