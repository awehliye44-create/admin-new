import type { FinanceReconciliationResponse } from '@/hooks/useFinanceReconciliation';

const STORAGE_KEY = 'onecab.fr.ssot.snapshot.v2';
const SCHEMA_VERSION = 2;

export type PersistedFinanceReconciliationSnapshot = {
  savedAt: string;
  generated_at: string;
  schema_version: number;
  scopeKey: string;
  source_status: 'LIVE';
  response: FinanceReconciliationResponse;
};

export function snapshotScopeKey(
  regionId: string | null | undefined,
  serviceAreaId: string | null | undefined,
  dateFrom?: string | null,
  dateTo?: string | null,
): string {
  const area = serviceAreaId ?? 'all';
  const region = regionId ?? 'all';
  const from = dateFrom?.trim() || 'open';
  const to = dateTo?.trim() || 'open';
  return `${region}:${area}:${from}:${to}`;
}

export function saveFinanceReconciliationSnapshot(
  response: FinanceReconciliationResponse,
  scopeKey: string,
): void {
  try {
    const generatedAt = new Date().toISOString();
    const payload: PersistedFinanceReconciliationSnapshot = {
      savedAt: generatedAt,
      generated_at: generatedAt,
      schema_version: SCHEMA_VERSION,
      scopeKey,
      source_status: 'LIVE',
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
