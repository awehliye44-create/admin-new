/** Offline test/audit-only helpers; not part of Edge uploads. */
import { decideTipWindowPersistPath } from "../../../functions/_shared/completeTripB4aSSOT.ts";


/** Isolated OFF/ON model: count tip re-SELECT queries for identical RETURNING outcomes. */
export function measureCompleteTripB4aReselectWorkload(params: {
  enabled: boolean;
  cases: Array<{
    hasExpectedOpen: boolean;
    returningAuthoritative: boolean;
    returningRowPresent: boolean;
    returningHasAllTipFields: boolean;
  }>;
}): { reselect_queries: number; skip_reselect: number } {
  let reselect_queries = 0;
  let skip_reselect = 0;
  for (const c of params.cases) {
    const d = decideTipWindowPersistPath({
      b4aEnabled: params.enabled,
      ...c,
    });
    if (d.performReselect) reselect_queries += 1;
    else if (d.action === "skip_reselect_returning_authoritative") {
      skip_reselect += 1;
    }
  }
  return { reselect_queries, skip_reselect };
}

export * from "../../../functions/_shared/completeTripB4aSSOT.ts";
