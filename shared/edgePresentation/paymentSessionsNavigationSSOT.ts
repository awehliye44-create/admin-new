/** Admin presentation-only helpers; not part of Edge uploads. */
/**
 * Payment Sessions — lifecycle tabs (Captured, Released, Refunded, Recovery).
 * Customer/provider payment lifecycle only — no driver wallet or payout ownership.
 */
import type {
  AdminPaymentSessionsListRequest,
  AdminPaymentSessionsListRow,
  AdminPaymentSessionsSummary,
  AdminPaymentSessionsTab,
} from '../../supabase/functions/_shared/adminPaymentSessionsSSOT.ts';

import {
  rowBelongsInCapturedTab,
  rowBelongsInRefundedTab,
  rowBelongsInReleasedTab,
} from '../../supabase/functions/_shared/paymentSessionsDisplaySSOT.ts';

import {
  isVerifiedCurrentActiveHoldRow,
  rowNeedsActiveReleaseNow,
  rowNeedsManualRecoveryNow,
  rowNeedsReleaseFailedNow,
} from '../../supabase/functions/_shared/paymentSessionsOperationalChipsSSOT.ts';
import { PaymentSessionsOpChip, PAYMENT_SESSIONS_OP_CHIP_LABELS, PAYMENT_SESSIONS_NAV_TABS, PaymentSessionsNavTab, LEGACY_TAB_MAP, resolveLegacyPaymentSessionsIssueParams, LEGACY_QUERY_KEYS, isRecoveringRow, isCaptureFailedRow, isReleaseFailedRow, rowMatchesOpChip, PaymentSessionsOperationalChip, countPaymentSessionsOpChip } from "../../supabase/functions/_shared/paymentSessionsNavigationSSOT.ts";


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

  // Independent of release-pending — concurrent holds must still surface.
  const verifiedActive = summary.verified_active_hold_count ?? summary.active_hold_count ?? 0;
  if (verifiedActive > 0) {
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

  const refundFailed = summary.capture_failed_count ?? 0;
  if (refundFailed > 0) {
    chips.push({
      id: 'refund_failed',
      label: PAYMENT_SESSIONS_OP_CHIP_LABELS.refund_failed,
      count: refundFailed,
      navTab: 'recovery',
    });
  }

  const refundPending = countPaymentSessionsOpChip('refund_pending', summary) ?? 0;
  if (refundPending > 0) {
    chips.push({
      id: 'refund_pending',
      label: PAYMENT_SESSIONS_OP_CHIP_LABELS.refund_pending,
      count: refundPending,
      navTab: 'refunded',
    });
  }

  const recoveryRequired = countPaymentSessionsOpChip('recovery_required', summary) ?? 0;
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

export * from "../../supabase/functions/_shared/paymentSessionsNavigationSSOT.ts";
