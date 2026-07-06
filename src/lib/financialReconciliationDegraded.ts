import type { FinanceReconciliationSummary } from '@/hooks/useFinanceReconciliation';
import { safeReconciliationCheck } from '@/lib/financialReconciliationGuards';

const DEGRADED_STATUS = 'DEGRADED_SNAPSHOT' as any;

function degradeCheck(
  check: FinanceReconciliationSummary['reconciliation_check'],
): FinanceReconciliationSummary['reconciliation_check'] {
  const base = safeReconciliationCheck({ reconciliation_check: check } as FinanceReconciliationSummary);
  const degradeLeg = <T extends { balanced?: boolean; status?: string }>(leg: T): T => ({
    ...leg,
    balanced: false,
    status: DEGRADED_STATUS,
  });

  return {
    ...base,
    balanced: false,
    status: DEGRADED_STATUS,
    card_reconciliation: degradeLeg(base.card_reconciliation),
  };
}

/** Snapshot display must never show BALANCED while SSOT is degraded. */
export function applyDegradedReconciliationSummary(
  summary: FinanceReconciliationSummary,
): FinanceReconciliationSummary {
  return {
    ...summary,
    reconciliation_check: degradeCheck(summary.reconciliation_check),
    ssot: {
      ...summary.ssot,
      data_source_badge: DEGRADED_STATUS,
    },
  };
}
