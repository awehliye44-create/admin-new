import type { UseQueryResult } from '@tanstack/react-query';
import type { MondayPayoutDiagnosticsResponse } from '@/hooks/useMondayPayoutDiagnostics';

/** Shared Monday payout diagnostics scope — full audit table, London “today” cards only. */
export const MONDAY_PAYOUT_DIAGNOSTICS_OPTS = {
  allKinds: true,
  today: false,
} as const;

export const PAYOUT_AUDIT_TABLE_TITLE = 'Payout Audit — who was paid';

export const PAYOUT_AUDIT_TABLE_DESCRIPTION =
  'All recorded payout items (weekly, manual, early cashout) for the selected period. Status reflects ledger/provider state — Paid does not mean bank arrival until Stripe reports in transit or paid.';

export const PAYOUT_AUDIT_EMPTY_MESSAGE =
  'No payout records yet. Failed payouts always appear here once recorded.';

export const FINANCE_SSOT_FOOTNOTE =
  'Trip Settlement (Trip History) calculates trip money. Financial Reconciliation audits Stripe integrity only.';

export type MondayPayoutQuery = Pick<
  UseQueryResult<MondayPayoutDiagnosticsResponse>,
  'data' | 'isLoading'
>;
