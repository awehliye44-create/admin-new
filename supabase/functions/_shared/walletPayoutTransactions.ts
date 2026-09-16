/** Wallet payout-tab transaction merge/pagination helpers. */

export type WalletPayoutTransaction = {
  id: string;
  occurred_at?: string | null;
  amount_pence?: number | null;
  type?: string | null;
  [key: string]: unknown;
};

export function mergePayoutTabTransactions(
  rows: WalletPayoutTransaction[],
): WalletPayoutTransaction[] {
  const seen = new Set<string>();
  const out: WalletPayoutTransaction[] = [];
  for (const row of rows ?? []) {
    const id = String(row.id ?? "");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(row);
  }
  return out;
}

export function paginatePayoutTransactions(
  rows: WalletPayoutTransaction[],
  args: { limit: number; cursor?: string | null },
): { items: WalletPayoutTransaction[]; nextCursor: string | null } {
  const limit = Math.max(1, Math.min(100, Number(args.limit) || 20));
  let start = 0;
  if (args.cursor) {
    const idx = rows.findIndex((r) => String(r.id) === String(args.cursor));
    start = idx >= 0 ? idx + 1 : 0;
  }
  const items = rows.slice(start, start + limit);
  const nextCursor = items.length === limit ? String(items[items.length - 1]?.id ?? "") || null : null;
  return { items, nextCursor };
}
