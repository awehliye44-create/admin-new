/**
 * Classify admin-finance-reconciliation failures for admin UX.
 * Never invent money; only map transport/auth/contract errors to messages.
 */

export type FinanceReconciliationFailureKind =
  | 'session_expired'
  | 'forbidden'
  | 'not_deployed'
  | 'wrong_contract'
  | 'server_error'
  | 'network'
  | 'unknown';

export type FinanceReconciliationFailure = {
  kind: FinanceReconciliationFailureKind;
  userMessage: string;
  diagnostics: string;
  httpStatus: number | null;
};

const FN = 'admin-finance-reconciliation';

export function classifyFinanceReconciliationError(err: unknown): FinanceReconciliationFailure {
  const raw = err instanceof Error ? err.message : String(err ?? 'Unknown error');
  const statusMatch = raw.match(/returned (\d{3})/);
  const httpStatus = statusMatch ? Number(statusMatch[1]) : null;

  if (httpStatus === 401 || /unauthorized|session expired|jwt/i.test(raw)) {
    return {
      kind: 'session_expired',
      userMessage: 'Admin session expired — sign in again',
      diagnostics: raw,
      httpStatus: httpStatus ?? 401,
    };
  }
  if (httpStatus === 403 || /forbidden|permission/i.test(raw)) {
    return {
      kind: 'forbidden',
      userMessage: 'You do not have Financial Reconciliation permission',
      diagnostics: `${raw}\nRequired permission slug: financial-reconciliation`,
      httpStatus: httpStatus ?? 403,
    };
  }
  if (httpStatus === 404 || /not found|not deployed/i.test(raw)) {
    return {
      kind: 'not_deployed',
      userMessage: 'Financial Reconciliation backend is not deployed',
      diagnostics: `${raw}\nExpected function: ${FN}`,
      httpStatus: httpStatus ?? 404,
    };
  }
  if (
    /wrong.?contract|finance_reconciliation_summary|orphan stub|revolut_provider_only|provider_only_count/i.test(raw)
  ) {
    return {
      kind: 'wrong_contract',
      userMessage:
        'Financial Reconciliation backend returned the wrong API contract. The live function was overwritten — restore admin-new SSOT.',
      diagnostics: raw,
      httpStatus,
    };
  }
  if (httpStatus != null && httpStatus >= 500) {
    return {
      kind: 'server_error',
      userMessage: 'Financial Reconciliation backend error — retry or use the last successful snapshot if available',
      diagnostics: raw,
      httpStatus,
    };
  }
  if (/unreachable|failed to fetch|network|cors|load failed|timed out/i.test(raw)) {
    return {
      kind: 'network',
      userMessage: 'Could not reach Financial Reconciliation backend — check connectivity and retry',
      diagnostics: raw,
      httpStatus,
    };
  }
  return {
    kind: 'unknown',
    userMessage: 'Financial Reconciliation is temporarily unavailable',
    diagnostics: raw,
    httpStatus,
  };
}

/** Reject orphan/stub payloads that collide on the same function name. */
export function assertFinanceReconciliationSsotResponse(data: unknown): void {
  if (!data || typeof data !== 'object') {
    throw new Error(`${FN} returned an empty or invalid body`);
  }
  const row = data as Record<string, unknown>;
  if (row.finance_reconciliation_summary && typeof row.finance_reconciliation_summary === 'object') {
    return;
  }
  if (
    'revolut_provider_only' in row
    || 'provider_only_count' in row
    || (row.summary && typeof row.summary === 'object' && 'revolut_orphan_count' in (row.summary as object))
  ) {
    throw new Error(
      `${FN} wrong contract: orphan/provider-only payload (missing finance_reconciliation_summary). Redeploy SSOT from admin-new.`,
    );
  }
  throw new Error(
    `${FN} wrong contract: missing finance_reconciliation_summary`,
  );
}
