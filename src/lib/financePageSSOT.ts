import type { UseQueryResult } from '@tanstack/react-query';
import type { MondayPayoutDiagnosticsResponse } from '@/hooks/useMondayPayoutDiagnostics';

/** Shared Monday payout diagnostics scope — full audit table, London “today” cards only. */
export const MONDAY_PAYOUT_DIAGNOSTICS_OPTS = {
  allKinds: true,
  today: false,
} as const;

export const PAYOUT_AUDIT_TABLE_TITLE = 'Payout Audit — who was paid';

export const PAYOUT_AUDIT_TABLE_DESCRIPTION =
  'All recorded payout items (weekly, manual, early cashout). Use Provider reference to verify in Stripe Connect. “Today” cards above only sum rows with activity on the current London day.';

export const PAYOUT_AUDIT_EMPTY_MESSAGE =
  'No payout records yet. Failed payouts always appear here once recorded.';

export const FINANCE_SSOT_FOOTNOTE =
  'Financial Reconciliation is the accounting source of truth. Payout totals reflect driver Connect transfers, not ONECAB corporate bank receipts.';

export type MondayPayoutQuery = Pick<
  UseQueryResult<MondayPayoutDiagnosticsResponse>,
  'data' | 'isLoading'
>;
