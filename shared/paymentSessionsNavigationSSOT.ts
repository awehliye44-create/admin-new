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

const LEGACY_TAB_MAP: Record<string, PaymentSessionsNavTab> = {
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

export function parsePaymentSessionsOpChip(raw: string | null | undefined): PaymentSessionsOpChip {
  if (raw === 'recovery_pending') return 'recovery_required';
  if (raw === 'capture_failed') return 'refund_failed';
  if (raw === 'release_failed') return 'release_failed';
  if (raw === 'active_holds' || raw === 'active_hold') return 'active_holds';
  if (raw && (Object.keys(PAYMENT_SESSIONS_OP_CHIP_LABELS) as PaymentSessionsOpChip[]).includes(raw as PaymentSessionsOpChip)) {
    return raw as PaymentSessionsOpChip;
  }
  return 'all';
}

/** Legacy ?tab= URLs → canonical lifecycle tabs. */
export function paymentSessionsLegacyTabRedirect(tab: string | null | undefined): string | null {
  if (!tab || PAYMENT_SESSIONS_NAV_TABS.includes(tab as PaymentSessionsNavTab)) return null;
  const mapped = tab ? LEGACY_TAB_MAP[tab] : null;
  if (!mapped) return '/payment-sessions?tab=captured';
  if (tab === 'active_holds') return '/payment-sessions?tab=captured&opFilter=active_holds';
  if (tab === 'failed_recovery') return '/payment-sessions?tab=recovery&opFilter=recovery_required';
  return `/payment-sessions?tab=${mapped}`;
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

const LEGACY_QUERY_KEYS = [
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

export function normalizePaymentSessionsSearchParams(
  searchParams: URLSearchParams,
): string | null {
  const next = new URLSearchParams(searchParams);
  let changed = false;

  const rawTab = searchParams.get('tab');
  if (rawTab && !PAYMENT_SESSIONS_NAV_TABS.includes(rawTab as PaymentSessionsNavTab)) {
    const mapped = LEGACY_TAB_MAP[rawTab];
    if (mapped) {
      next.set('tab', mapped);
      changed = true;
    } else {
      next.set('tab', 'captured');
      changed = true;
    }
  }

  if (!next.get('tab')) {
    next.set('tab', 'captured');
    changed = true;
  }

  const legacyOp = resolveLegacyPaymentSessionsIssueParams(searchParams);
  if (legacyOp && legacyOp !== 'all') {
    if (next.get('opFilter') !== legacyOp) {
      next.set('opFilter', legacyOp);
      changed = true;
    }
    if (legacyOp === 'release_pending' && next.get('tab') !== 'captured') {
      next.set('tab', 'captured');
      changed = true;
    }
    if (legacyOp === 'active_holds' && next.get('tab') !== 'captured') {
      next.set('tab', 'captured');
      changed = true;
    }
    if (legacyOp === 'recovery_required' && next.get('tab') !== 'recovery') {
      next.set('tab', 'recovery');
      changed = true;
    }
    if (legacyOp === 'release_failed' && next.get('tab') !== 'recovery') {
      next.set('tab', 'recovery');
      changed = true;
    }
  }

  for (const key of LEGACY_QUERY_KEYS) {
    if (next.has(key)) {
      next.delete(key);
      changed = true;
    }
  }

  const hasEntityDeepLink = Boolean(
    next.get('paymentSessionId')
    || next.get('providerOrderId')
    || next.get('tripId')
    || next.get('customerId'),
  );
  if (hasEntityDeepLink && !rawTab) {
    next.set('tab', 'captured');
    changed = true;
  }

  if (!changed) return null;
  const qs = next.toString();
  return qs ? `/payment-sessions?${qs}` : '/payment-sessions';
}

export function isPaymentSessionsProviderPollBackendTab(
  tab: AdminPaymentSessionsTab | undefined,
): boolean {
  return tab === 'active_holds' || tab === 'failed_recovery';
}

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

export function buildPaymentSessionsBackendRequest(args: {
  navTab: PaymentSessionsNavTab;
  opChip?: PaymentSessionsOpChip;
  base: Omit<AdminPaymentSessionsListRequest, 'tab'>;
}): AdminPaymentSessionsListRequest {
  const opChip = args.opChip ?? 'all';
  let tab: AdminPaymentSessionsTab = 'captured';
  const req: AdminPaymentSessionsListRequest = { ...args.base };

  switch (args.navTab) {
    case 'released':
      tab = 'released';
      break;
    case 'refunded':
      tab = 'refunded';
      break;
    case 'recovery':
      tab = 'failed_recovery';
      if (opChip === 'recovery_required') req.recovery_pending = true;
      break;
    case 'captured':
    default:
      tab = 'captured';
      break;
  }

  if (opChip === 'release_failed') req.release_failed = true;
  if (opChip === 'refund_failed') req.capture_failed = true;
  if (opChip === 'release_pending') {
    tab = 'captured';
    req.operational_chip = 'release_pending';
  }
  if (opChip === 'active_holds') {
    tab = 'captured';
    req.operational_chip = 'active_holds';
  }
  if (opChip === 'recovery_required') {
    tab = 'failed_recovery';
    req.recovery_pending = true;
    req.operational_chip = 'recovery_required';
  }

  req.tab = tab;
  return req;
}

export function filterPaymentSessionsRowsForNav(
  rows: AdminPaymentSessionsListRow[],
  navTab: PaymentSessionsNavTab,
  opChip: PaymentSessionsOpChip,
): AdminPaymentSessionsListRow[] {
  let filtered = rows;
  if (navTab === 'captured') {
    filtered = rows.filter((r) => rowBelongsInCapturedTab(r) || rowNeedsActiveReleaseNow(r));
  } else if (navTab === 'released') {
    filtered = rows.filter(rowBelongsInReleasedTab);
  } else if (navTab === 'refunded') {
    filtered = rows.filter(rowBelongsInRefundedTab);
  } else if (navTab === 'recovery') {
    filtered = rows.filter((r) => isRecoveringRow(r) || isCaptureFailedRow(r) || isReleaseFailedRow(r));
  }
  if (opChip !== 'all') {
    filtered = filtered.filter((r) => rowMatchesOpChip(r, opChip));
  }
  return filtered;
}

export function needsClientSidePaymentSessionsNavFilter(args: {
  navTab: PaymentSessionsNavTab;
  opChip: PaymentSessionsOpChip;
  search: string;
}): boolean {
  if (args.search.trim()) return true;
  if (args.opChip === 'refund_pending') return true;
  if (args.navTab === 'recovery' && args.opChip === 'all') return true;
  return false;
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
      return null;
    case 'recovery_required':
      return summary.manual_recovery_required_count ?? summary.recovery_pending_count ?? 0;
    default:
      return null;
  }
}

export function shouldShowPaymentSessionsOpChip(
  chip: PaymentSessionsOpChip,
  count: number | null,
): boolean {
  if (chip === 'all') return false;
  if (chip === 'refund_failed') return count != null && count > 0;
  return count != null && count > 0;
}

/** Header operational chips — hide zero counts. */
export function buildPaymentSessionsOperationalChips(
  summary: AdminPaymentSessionsSummary | null | undefined,
): PaymentSessionsOperationalChip[] {
  if (!summary) return [];
  const chips: PaymentSessionsOperationalChip[] = [];

  const releaseNeeded = summary.actionable_release_pending_count ?? 0;
  if (releaseNeeded > 0) {
    chips.push({
      id: 'release_pending',
      label: PAYMENT_SESSIONS_OP_CHIP_LABELS.release_pending,
      count: releaseNeeded,
      navTab: 'captured',
    });
  }

  const verifiedActive = summary.verified_active_hold_count ?? summary.active_hold_count ?? 0;
  if (verifiedActive > 0 && releaseNeeded === 0) {
    chips.push({
      id: 'active_holds',
      label: PAYMENT_SESSIONS_OP_CHIP_LABELS.active_holds,
      count: verifiedActive,
      navTab: 'captured',
    });
  }

  const releaseFailed = summary.release_failed_count ?? 0;
  if (releaseFailed > 0) {
    chips.push({
      id: 'release_failed',
      label: PAYMENT_SESSIONS_OP_CHIP_LABELS.release_failed,
      count: releaseFailed,
      navTab: 'recovery',
    });
  }

  const recoveryRequired = summary.manual_recovery_required_count ?? 0;
  if (recoveryRequired > 0) {
    chips.push({
      id: 'recovery_required',
      label: PAYMENT_SESSIONS_OP_CHIP_LABELS.recovery_required,
      count: recoveryRequired,
      navTab: 'recovery',
    });
  }

  return chips;
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

export function buildPaymentSessionsNavPatch(args: {
  tab: PaymentSessionsNavTab;
  opFilter?: PaymentSessionsOpChip | null;
}): Record<string, string | null> {
  return {
    tab: args.tab,
    opFilter: args.opFilter == null || args.opFilter === 'all' ? null : args.opFilter,
  };
}

export function resolvePaymentSessionsFilteredTotal(args: {
  clientFiltered: boolean;
  navTab: PaymentSessionsNavTab;
  opChip: PaymentSessionsOpChip;
  summary: AdminPaymentSessionsSummary | null | undefined;
  backendFilteredTotal: number | null | undefined;
  displayRowCount: number;
  hasSearch: boolean;
}): number {
  if (!args.clientFiltered) {
    return args.backendFilteredTotal ?? args.displayRowCount;
  }
  if (args.hasSearch) return args.displayRowCount;
  const chipCount = countPaymentSessionsOpChip(args.opChip, args.summary);
  if (args.opChip !== 'all' && chipCount != null) return chipCount;
  if (args.navTab === 'captured') return args.summary?.captured_count ?? args.backendFilteredTotal ?? args.displayRowCount;
  if (args.navTab === 'released') return args.summary?.released_count ?? args.backendFilteredTotal ?? args.displayRowCount;
  if (args.navTab === 'refunded') return args.summary?.refunded_count ?? args.backendFilteredTotal ?? args.displayRowCount;
  if (args.navTab === 'recovery') {
    return (args.summary?.manual_recovery_required_count ?? args.summary?.recovery_pending_count ?? 0)
      + (args.summary?.failed_recovery_count ?? 0);
  }
  return args.backendFilteredTotal ?? args.displayRowCount;
}

export function resolvePaymentSessionsListHasMore(args: {
  clientFiltered: boolean;
  listOffset: number;
  rawRowCount: number;
  pageLimit: number;
  backendHasMore: boolean;
  filteredTotal: number;
}): boolean {
  if (!args.clientFiltered) return args.backendHasMore;
  if (args.rawRowCount < args.pageLimit) return false;
  return args.listOffset + args.rawRowCount < args.filteredTotal && args.backendHasMore;
}

/** @deprecated */
export type PaymentSessionsStatusChip = 'all' | 'captured' | 'released' | 'refunded' | 'authorised' | 'cancelled';
/** @deprecated */
export type PaymentSessionsIssueChip = 'all' | 'action_required' | 'active_holds' | 'recovering' | 'failed' | 'provider_fee_pending';
/** @deprecated */
export type PaymentSessionsHistoryChip = 'all';

export function parsePaymentSessionsStatusChip(): 'all' { return 'all'; }
export function parsePaymentSessionsIssueChip(raw: string | null | undefined): PaymentSessionsOpChip {
  if (raw && LEGACY_OP_FROM_ISSUE[raw]) return LEGACY_OP_FROM_ISSUE[raw];
  return parsePaymentSessionsOpChip(raw);
}
export function parsePaymentSessionsHistoryChip(): 'all' { return 'all'; }
