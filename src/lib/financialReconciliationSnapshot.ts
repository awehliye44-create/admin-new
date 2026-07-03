import type { FinanceReconciliationResponse } from '@/hooks/useFinanceReconciliation';

const STORAGE_KEY = 'onecab.fr.ssot.snapshot.v1';

export type PersistedFinanceReconciliationSnapshot = {
  savedAt: string;
  scopeKey: string;
  response: FinanceReconciliationResponse;
};

export function snapshotScopeKey(regionId: string | null | undefined, serviceAreaId: string | null | undefined): string {
  return `${regionId ?? 'all'}:${serviceAreaId ?? 'all'}`;
}

export function saveFinanceReconciliationSnapshot(
  response: FinanceReconciliationResponse,
  scopeKey: string,
): void {
  try {
    const payload: PersistedFinanceReconciliationSnapshot = {
      savedAt: new Date().toISOString(),
      scopeKey,
      response,
    };
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Ignore quota / private mode errors.
  }
}

export function loadFinanceReconciliationSnapshot(
  scopeKey?: string | null,
): PersistedFinanceReconciliationSnapshot | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedFinanceReconciliationSnapshot;
    if (!parsed?.response?.finance_reconciliation_summary) return null;
    if (scopeKey != null && parsed.scopeKey !== scopeKey) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearFinanceReconciliationSnapshot(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore private mode / quota errors.
  }
}
