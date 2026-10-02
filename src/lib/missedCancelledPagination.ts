/**
 * Missed & Cancelled offset pages over
 * ORDER BY missed_cancelled_event_at, id (same direction) — see adminTripListDateSort.
 */

export function missedCancelledPageRange(page: number, pageSize: number): { from: number; to: number } {
  const safePage = Math.max(0, Math.floor(page));
  const from = safePage * pageSize;
  return { from, to: from + pageSize - 1 };
}

/**
 * Next page exists when the server-side count extends past this page. Uses the
 * exact count of the ordered query, not the rows left after client-side
 * defence-in-depth filtering.
 */
export function missedCancelledHasNextPage(page: number, pageSize: number, totalCount: number): boolean {
  const { to } = missedCancelledPageRange(page, pageSize);
  return to + 1 < totalCount;
}
