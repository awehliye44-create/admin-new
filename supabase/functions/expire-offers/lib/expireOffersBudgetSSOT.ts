/**
 * B1 — wall-clock budget for expire-offers critical section.
 * Stops starting new work units when exhausted; never aborts mid-unit mutation.
 */

export type ExpireOffersBudget = {
  budgetMs: number;
  /** true when unlimited (budgetMs === 0) */
  unlimited: boolean;
  remainingMs: () => number;
  exhausted: () => boolean;
  /** Mark that we stopped early due to budget. */
  markExhausted: () => void;
  wasExhausted: () => boolean;
};

export function createExpireOffersBudget(
  elapsedMs: () => number,
  budgetMs: number,
): ExpireOffersBudget {
  let flagged = false;
  const unlimited = budgetMs <= 0;
  return {
    budgetMs,
    unlimited,
    remainingMs: () => (unlimited ? Number.POSITIVE_INFINITY : Math.max(0, budgetMs - elapsedMs())),
    exhausted: () => {
      if (unlimited) return false;
      return elapsedMs() >= budgetMs;
    },
    markExhausted: () => {
      flagged = true;
    },
    wasExhausted: () => flagged,
  };
}

/** Return true if the next unit should be skipped (budget already spent). */
export function shouldSkipExpireOffersUnit(budget: ExpireOffersBudget): boolean {
  if (budget.unlimited) return false;
  if (!budget.exhausted()) return false;
  budget.markExhausted();
  return true;
}
