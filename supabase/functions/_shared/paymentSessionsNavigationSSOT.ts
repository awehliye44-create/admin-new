/**
 * Payment Sessions — lifecycle tabs (Captured, Released, Refunded, Recovery).
 * Customer/provider payment lifecycle only — no driver wallet or payout ownership.
 */
import type {
  AdminPaymentSessionsListRequest,
  AdminPaymentSessionsListRow,
  AdminPaymentSessionsSummary,
  AdminPaymentSessionsTab,
} from './adminPaymentSessionsSSOT.ts';
import {
  rowBelongsInCapturedTab,
  rowBelongsInRefundedTab,
  rowBelongsInReleasedTab,
} from './paymentSessionsDisplaySSOT.ts';
import {
  isVerifiedCurrentActiveHoldRow,
  rowNeedsActiveReleaseNow,
  rowNeedsManualRecoveryNow,
  rowNeedsReleaseFailedNow,
} from './paymentSessionsOperationalChipsSSOT.ts';

export type PaymentSessionsNavTab = 'captured' | 'released' | 'refunded' | 'recovery';

export type PaymentSessionsOpChip =
  | 'all'
  | 'active_holds'
  | 'release_pending'
  | 'release_failed'
  | 'refund_pending'
  | 'refund_failed'
  | 'recovery_required';

export const PAYMENT_SESSIONS_NAV_TABS: PaymentSessionsNavTab[] = [
  'captured',
  'released',
  'refunded',
  'recovery',
];

export const PAYMENT_SESSIONS_OP_CHIP_LABELS: Record<PaymentSessionsOpChip, string> = {
  all: 'All',
  active_holds: 'Active holds',
  release_pending: 'Active releases',
  release_failed: 'Release failed',
  refund_pending: 'Refund pending',
  refund_failed: 'Refund failed',
  recovery_required: 'Manual recovery',
};

export const LEGACY_TAB_MAP: Record<string, PaymentSessionsNavTab> = {
  overview: 'captured',
  sessions: 'captured',
  issues: 'recovery',
  history: 'captured',
  provider_payments: 'captured',
  active_holds: 'captured',
  captured: 'captured',
  'captured_provider_confirmed': 'captured',
  released: 'released',
  refunded: 'refunded',
  failed_recovery: 'recovery',
  recovery: 'recovery',
  completed_trips_paid: 'captured',
  payment_matching: 'captured',
};

const LEGACY_OP_FROM_ISSUE: Record<string, PaymentSessionsOpChip> = {
  action_required: 'release_failed',
  active_holds: 'active_holds',
  recovering: 'recovery_required',
  failed: 'release_failed',
  capture_failed: 'refund_failed',
  release_failed: 'release_failed',
  recovery_pending: 'recovery_required',
  provider_fees_pending: 'all',
};

export function parsePaymentSessionsNavTab(raw: string | null | undefined): PaymentSessionsNavTab {
  if (raw && PAYMENT_SESSIONS_NAV_TABS.includes(raw as PaymentSessionsNavTab)) {
    return raw as PaymentSessionsNavTab;
  }
  if (raw && LEGACY_TAB_MAP[raw]) return LEGACY_TAB_MAP[raw];
  return 'captured';
}

export function resolveLegacyPaymentSessionsIssueParams(
  searchParams: URLSearchParams,
): PaymentSessionsOpChip | null {
  if (searchParams.get('captureFailed') === '1') return 'refund_failed';
  if (searchParams.get('releaseFailed') === '1') return 'release_failed';
  if (searchParams.get('recoveryPending') === '1') return 'recovery_required';
  if (searchParams.get('moneyAtRisk') === '1') return 'release_failed';
  const issueFilter = searchParams.get('issueFilter');
  if (issueFilter && LEGACY_OP_FROM_ISSUE[issueFilter]) {
    return LEGACY_OP_FROM_ISSUE[issueFilter];
  }
  const sessionFilter = searchParams.get('sessionFilter');
  if (sessionFilter === 'authorised') return 'active_holds';
  return null;
}

/** @deprecated Use parsePaymentSessionsNavTab */
export function resolveLegacyPaymentSessionsTabMapping(tab: string | null | undefined): {
  navTab: PaymentSessionsNavTab;
  opChip?: PaymentSessionsOpChip;
} {
  if (tab && PAYMENT_SESSIONS_NAV_TABS.includes(tab as PaymentSessionsNavTab)) {
    return { navTab: tab as PaymentSessionsNavTab };
  }
  if (tab && LEGACY_TAB_MAP[tab]) {
    const navTab = LEGACY_TAB_MAP[tab];
    if (tab === 'active_holds') return { navTab: 'captured', opChip: 'active_holds' };
    if (tab === 'failed_recovery') return { navTab: 'recovery', opChip: 'recovery_required' };
    if (tab === 'captured') return { navTab: 'captured' };
    return { navTab };
  }
  return { navTab: 'captured' };
}

export const LEGACY_QUERY_KEYS = [
  'captureFailed',
  'releaseFailed',
  'recoveryPending',
  'providerFeesPending',
  'moneyAtRisk',
  'matchStatus',
  'sessionFilter',
  'issueFilter',
  'historyFilter',
] as const;

function upper(v: unknown): string {
  return String(v ?? '').toUpperCase();
}

export function isCaptureFailedRow(row: AdminPaymentSessionsListRow): boolean {
  return upper(row.session_status_display) === 'CAPTURE_FAILED'
    || String(row.session_status_label ?? '').includes('CAPTURE FAILED')
    || String(row.attention_class ?? '').includes('CAPTURE_FAILED')
    || row.evidence_status === 'CAPTURE_AMOUNT_MISSING'
    || upper(row.session_status_display) === 'FAILED';
}

export function isReleaseFailedRow(row: AdminPaymentSessionsListRow): boolean {
  return rowNeedsReleaseFailedNow(row);
}

export function isReleasePendingRow(row: AdminPaymentSessionsListRow): boolean {
  return rowNeedsActiveReleaseNow(row);
}

export function isRecoveringRow(row: AdminPaymentSessionsListRow): boolean {
  return rowNeedsManualRecoveryNow(row);
}

export function isRefundPendingRow(row: AdminPaymentSessionsListRow): boolean {
  const outstanding = row.outstanding_pence ?? row.difference_pence;
  return outstanding != null && outstanding > 0
    && rowBelongsInCapturedTab(row)
    && (row.refunded_amount_pence ?? 0) === 0;
}

export function isRefundFailedRow(row: AdminPaymentSessionsListRow): boolean {
  return isCaptureFailedRow(row)
    || upper(row.action_classification ?? '').includes('REFUND')
    && upper(row.session_status_display).includes('FAIL');
}

export function rowMatchesOpChip(
  row: AdminPaymentSessionsListRow,
  chip: PaymentSessionsOpChip,
): boolean {
  if (chip === 'all') return true;
  if (chip === 'active_holds') return isVerifiedCurrentActiveHoldRow(row);
  if (chip === 'release_pending') return isReleasePendingRow(row);
  if (chip === 'release_failed') return isReleaseFailedRow(row);
  if (chip === 'refund_pending') return isRefundPendingRow(row);
  if (chip === 'refund_failed') return isRefundFailedRow(row);
  if (chip === 'recovery_required') return isRecoveringRow(row);
  return true;
}

export type PaymentSessionsOperationalChip = {
  id: PaymentSessionsOpChip;
  label: string;
  count: number;
  navTab?: PaymentSessionsNavTab;
};

export function countPaymentSessionsOpChip(
  chip: PaymentSessionsOpChip,
  summary: AdminPaymentSessionsSummary | null | undefined,
): number | null {
  if (!summary) return null;
  switch (chip) {
    case 'active_holds':
      return summary.verified_active_hold_count ?? summary.active_hold_count ?? 0;
    case 'release_pending':
      return summary.actionable_release_pending_count ?? 0;
    case 'release_failed':
      return summary.release_failed_count ?? 0;
    case 'refund_pending':
      return summary.outstanding_customer_overcharge_pence != null && summary.outstanding_customer_overcharge_pence > 0
        ? 1
        : 0;
    case 'refund_failed':
      return summary.capture_failed_count ?? null;
    case 'recovery_required': {
      const manual = summary.manual_recovery_required_count ?? summary.recovery_pending_count ?? 0;
      const failed = summary.failed_recovery_count ?? 0;
      return manual + failed;
    }
    default:
      return null;
  }
}

export function paymentSessionsNavUrl(args?: {
  tab?: PaymentSessionsNavTab;
  opFilter?: PaymentSessionsOpChip;
  paymentSessionId?: string | null;
  providerOrderId?: string | null;
  tripId?: string | null;
  customerId?: string | null;
}): string {
  const params = new URLSearchParams();
  const hasEntityDeepLink = Boolean(
    args?.paymentSessionId
    || args?.providerOrderId
    || args?.tripId
    || args?.customerId,
  );
  params.set('tab', args?.tab ?? (hasEntityDeepLink ? 'captured' : 'captured'));
  if (args?.opFilter && args.opFilter !== 'all') {
    params.set('opFilter', args.opFilter);
  }
  if (args?.paymentSessionId) params.set('paymentSessionId', args.paymentSessionId);
  if (args?.providerOrderId) params.set('providerOrderId', args.providerOrderId);
  if (args?.tripId) params.set('tripId', args.tripId);
  if (args?.customerId) params.set('customerId', args.customerId);
  const qs = params.toString();
  return qs ? `/payment-sessions?${qs}` : '/payment-sessions';
}

