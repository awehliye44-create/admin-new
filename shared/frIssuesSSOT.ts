import { isDriverCreditExceptionHealth } from './driverCreditMonitoringSSOT';

/** Minimal trip audit shape for issue classification (frontend + tests). */
export type FrIssueTripRow = {
  trip_id: string;
  trip_code?: string | null;
  date?: string | null;
  driver_id?: string | null;
  driver_name?: string | null;
  payment_method?: string | null;
  capture_mismatch?: boolean;
  reconciliation_status?: { label?: string | null; tone?: string | null } | null;
  capture_reconciliation_status?: string | null;
  release_reconciliation_status?: string | null;
  wallet_reconciliation_status?: string | null;
  payout_reconciliation_status?: string | null;
  capture_variance_pence?: number | null;
  outstanding_pence?: number | null;
  captured_pence?: number | null;
  wallet_variance_pence?: number | null;
  credit_difference_pence?: number | null;
  payout_variance_pence?: number | null;
  expected_driver_credit_pence?: number | null;
  actual_driver_credit_pence?: number | null;
  ps_expected_capture_pence?: number | null;
  driver_credit_health?: string | null;
  payment_session_id?: string | null;
};

export type FrIssueFilter =
  | 'all'
  | 'critical'
  | 'shortfalls'
  | 'missing_capture'
  | 'missing_release'
  | 'driver_credit'
  | 'payout'
  | 'resolved';

export type FrIssueType =
  | 'shortfall'
  | 'missing_capture'
  | 'missing_release'
  | 'driver_credit'
  | 'payout'
  | 'capture_mismatch'
  | 'wallet_mismatch'
  | 'resolved';

export type FrUnifiedIssue = {
  trip_id: string;
  date: string | null;
  trip_code: string | null;
  driver_id: string | null;
  driver_name: string | null;
  issue_type: FrIssueType;
  issue_label: string;
  expected_pence: number | null;
  actual_pence: number | null;
  difference_pence: number | null;
  status: string;
  driver_credit_health?: string | null;
  is_critical: boolean;
  is_resolved: boolean;
  payment_session_id: string | null;
};

export const FR_ISSUE_FILTER_LABELS: Record<FrIssueFilter, string> = {
  all: 'All',
  critical: 'Critical',
  shortfalls: 'Shortfalls',
  missing_capture: 'Missing capture',
  missing_release: 'Missing release',
  driver_credit: 'Driver credit',
  payout: 'Payout',
  resolved: 'Resolved',
};

export const FR_ISSUE_FILTERS: FrIssueFilter[] = [
  'all',
  'critical',
  'shortfalls',
  'missing_capture',
  'missing_release',
  'driver_credit',
  'payout',
  'resolved',
];

const LEGACY_FR_TAB_TO_ISSUE_FILTER: Record<string, FrIssueFilter> = {
  mismatches: 'all',
  shortfall: 'shortfalls',
  missing_captures: 'missing_capture',
  missing_releases: 'missing_release',
  wallet_mismatches: 'driver_credit',
  payout_mismatches: 'payout',
  alerts: 'critical',
  history: 'resolved',
  recovery: 'shortfalls',
};

export function resolveLegacyFrTabIssueFilter(tab: string | null | undefined): FrIssueFilter | null {
  if (!tab) return null;
  return LEGACY_FR_TAB_TO_ISSUE_FILTER[tab] ?? null;
}

/** Map legacy FR tab query values to the simplified Issues tab URL. */
export function financialReconciliationLegacyTabRedirect(tab: string | null | undefined): string | null {
  const filter = resolveLegacyFrTabIssueFilter(tab);
  if (!filter) return null;
  return `/financial-reconciliation?tab=issues&issueFilter=${filter}`;
}

export type FrOverviewKpiCounts = {
  trip_count?: number;
  unresolved_mismatches_count?: number;
  driver_credit_exception_trip_count?: number;
  driver_credit_exception_difference_pence?: number;
};

/** Summary-only FR responses omit trip audit rows — audit_overview_kpis are all zero until full audit loads. */
export function hasFrPeriodAuditKpis(kpis?: FrOverviewKpiCounts | null): boolean {
  return (kpis?.trip_count ?? 0) > 0;
}

/** Prefer audit rows when loaded; fall back to summary KPIs for tab badges on Overview/Drivers. */
export function resolveFrTabBadgeCounts(args: {
  tripAuditRows: FrIssueTripRow[];
  unifiedOpenIssueCount: number;
  auditOverviewKpis?: FrOverviewKpiCounts | null;
  metaTripCount?: number;
}): {
  periodTripCount: number;
  openIssueCount: number;
} {
  const kpiTrips = hasFrPeriodAuditKpis(args.auditOverviewKpis)
    ? args.auditOverviewKpis!.trip_count!
    : null;
  const kpiOpen = hasFrPeriodAuditKpis(args.auditOverviewKpis)
    ? (args.auditOverviewKpis!.unresolved_mismatches_count ?? 0)
    : null;
  return {
    periodTripCount:
      args.tripAuditRows.length > 0
        ? args.tripAuditRows.length
        : (kpiTrips ?? args.metaTripCount ?? 0),
    openIssueCount:
      args.unifiedOpenIssueCount > 0
        ? args.unifiedOpenIssueCount
        : (kpiOpen ?? 0),
  };
}

export function resolveFrDriverCreditBanner(args: {
  tripAuditRows: FrIssueTripRow[];
  tripAgg: { exception_trip_count: number; total_difference_pence: number };
  auditOverviewKpis?: FrOverviewKpiCounts | null;
}): { exception_trip_count: number; total_difference_pence: number } {
  if (args.tripAuditRows.length > 0) return args.tripAgg;
  if (!hasFrPeriodAuditKpis(args.auditOverviewKpis)) {
    return { exception_trip_count: 0, total_difference_pence: 0 };
  }
  return {
    exception_trip_count: args.auditOverviewKpis?.driver_credit_exception_trip_count ?? 0,
    total_difference_pence: args.auditOverviewKpis?.driver_credit_exception_difference_pence ?? 0,
  };
}

export function parseFrIssueFilter(value: string | null | undefined): FrIssueFilter {
  if (value && (FR_ISSUE_FILTERS as readonly string[]).includes(value)) {
    return value as FrIssueFilter;
  }
  return 'all';
}

export function parseFrTripFilter(value: string | null | undefined): 'driver_credit' | null {
  return value === 'driver_credit' ? 'driver_credit' : null;
}

function isResolvedTrip(row: FrIssueTripRow): boolean {
  return !row.capture_mismatch
    && String(row.reconciliation_status?.label ?? '').toLowerCase().includes('balanced');
}

export function isShortfallTrip(row: FrIssueTripRow): boolean {
  return row.capture_reconciliation_status === 'CAPTURE_SHORTFALL'
    || (row.capture_variance_pence != null && row.capture_variance_pence < 0)
    || (row.outstanding_pence != null && row.outstanding_pence > 0);
}

export function isMissingCaptureTrip(row: FrIssueTripRow): boolean {
  const method = String(row.payment_method ?? '').toLowerCase();
  if (method === 'cash' || method.includes('cash')) return false;
  if (row.capture_reconciliation_status === 'CAPTURE_AMOUNT_UNKNOWN') return false;
  return row.capture_reconciliation_status === 'CAPTURE_MISSING'
    || row.capture_reconciliation_status === 'CAPTURE_PENDING'
    || row.capture_reconciliation_status === 'PAYMENT_SESSION_CAPTURE_MISMATCH'
    || row.captured_pence == null
    || !!row.capture_mismatch;
}

export function isMissingReleaseTrip(row: FrIssueTripRow): boolean {
  return row.release_reconciliation_status === 'RELEASE_PENDING'
    || row.release_reconciliation_status === 'RELEASE_SHORTFALL'
    || row.release_reconciliation_status === 'RELEASE_AMOUNT_UNKNOWN';
}

export function isDriverCreditIssueTrip(row: FrIssueTripRow): boolean {
  return isDriverCreditExceptionHealth(row.driver_credit_health);
}

export function isWalletMismatchTrip(row: FrIssueTripRow): boolean {
  const status = String(row.wallet_reconciliation_status ?? '');
  return String(row.reconciliation_status?.label ?? '') === 'WALLET_MISMATCH'
    || status.includes('MISSING')
    || status.includes('OVER')
    || status.includes('UNDER')
    || status.includes('DUPLICATE')
    || status.includes('WRONG')
    || (row.wallet_variance_pence != null && row.wallet_variance_pence !== 0)
    || (row.credit_difference_pence != null && row.credit_difference_pence !== 0);
}

export function isPayoutMismatchTrip(row: FrIssueTripRow): boolean {
  const status = String(row.payout_reconciliation_status ?? '');
  return status.includes('MISMATCH')
    || status.includes('FAILED')
    || status.includes('DUPLICATE');
}

export function isCaptureMismatchTrip(row: FrIssueTripRow): boolean {
  return !!row.capture_mismatch
    || String(row.reconciliation_status?.tone ?? '').toLowerCase() === 'error'
    || String(row.reconciliation_status?.tone ?? '').toLowerCase() === 'red'
    || String(row.reconciliation_status?.label ?? '').toLowerCase().includes('mismatch')
    || String(row.capture_reconciliation_status ?? '').includes('SHORTFALL')
    || String(row.capture_reconciliation_status ?? '').includes('MISSING');
}

function issueLabel(type: FrIssueType): string {
  switch (type) {
    case 'shortfall':
      return 'Shortfall';
    case 'missing_capture':
      return 'Missing capture';
    case 'missing_release':
      return 'Missing release';
    case 'driver_credit':
      return 'Driver credit';
    case 'payout':
      return 'Payout mismatch';
    case 'capture_mismatch':
      return 'Capture mismatch';
    case 'wallet_mismatch':
      return 'Wallet mismatch';
    case 'resolved':
      return 'Resolved';
    default:
      return 'Issue';
  }
}

function expectedActualForIssue(type: FrIssueType, row: FrIssueTripRow): {
  expected: number | null;
  actual: number | null;
  difference: number | null;
} {
  switch (type) {
    case 'shortfall':
      return {
        expected: row.ps_expected_capture_pence ?? null,
        actual: row.captured_pence ?? null,
        difference: row.capture_variance_pence ?? row.outstanding_pence ?? null,
      };
    case 'missing_capture':
      return {
        expected: row.ps_expected_capture_pence ?? null,
        actual: row.captured_pence ?? null,
        difference: row.capture_variance_pence ?? null,
      };
    case 'missing_release':
      return {
        expected: row.ps_expected_capture_pence ?? null,
        actual: row.captured_pence ?? null,
        difference: row.capture_variance_pence ?? null,
      };
    case 'driver_credit':
      return {
        expected: row.expected_driver_credit_pence ?? null,
        actual: row.actual_driver_credit_pence ?? null,
        difference: row.credit_difference_pence ?? row.wallet_variance_pence ?? null,
      };
    case 'payout':
      return {
        expected: row.expected_driver_credit_pence ?? null,
        actual: row.actual_driver_credit_pence ?? null,
        difference: row.payout_variance_pence ?? null,
      };
    case 'wallet_mismatch':
      return {
        expected: row.expected_driver_credit_pence ?? null,
        actual: row.actual_driver_credit_pence ?? row.captured_pence ?? null,
        difference: row.wallet_variance_pence ?? row.credit_difference_pence ?? null,
      };
    case 'capture_mismatch':
      return {
        expected: row.ps_expected_capture_pence ?? null,
        actual: row.captured_pence ?? null,
        difference: row.capture_variance_pence ?? null,
      };
    case 'resolved':
      return {
        expected: row.ps_expected_capture_pence ?? null,
        actual: row.captured_pence ?? null,
        difference: 0,
      };
    default:
      return { expected: null, actual: null, difference: null };
  }
}

function isCriticalIssue(type: FrIssueType, row: FrIssueTripRow): boolean {
  if (type === 'resolved') return false;
  if (type === 'driver_credit') return true;
  if (type === 'shortfall') {
    return (row.outstanding_pence ?? 0) > 0
      || (row.capture_variance_pence ?? 0) < 0;
  }
  if (type === 'missing_capture' || type === 'missing_release') return true;
  if (type === 'payout') return true;
  if (type === 'capture_mismatch' || type === 'wallet_mismatch') {
    const diff = Math.abs(
      row.capture_variance_pence
      ?? row.wallet_variance_pence
      ?? row.credit_difference_pence
      ?? row.payout_variance_pence
      ?? 0,
    );
    return diff > 0 || !!row.capture_mismatch;
  }
  return false;
}

/** Build unified issue rows from trip audit payload (one row per trip × issue type). */
export function buildFrUnifiedIssues(rows: FrIssueTripRow[]): FrUnifiedIssue[] {
  const issues: FrUnifiedIssue[] = [];

  for (const row of rows) {
    if (isResolvedTrip(row)) {
      const { expected, actual, difference } = expectedActualForIssue('resolved', row);
      issues.push({
        trip_id: row.trip_id,
        date: row.date ?? null,
        trip_code: row.trip_code ?? null,
        driver_id: row.driver_id ?? null,
        driver_name: row.driver_name ?? null,
        issue_type: 'resolved',
        issue_label: issueLabel('resolved'),
        expected_pence: expected,
        actual_pence: actual,
        difference_pence: difference,
        status: row.reconciliation_status?.label ?? 'Balanced',
        is_critical: false,
        is_resolved: true,
        payment_session_id: row.payment_session_id ?? null,
      });
      continue;
    }

    const types: FrIssueType[] = [];
    if (isShortfallTrip(row)) types.push('shortfall');
    if (isMissingCaptureTrip(row)) types.push('missing_capture');
    if (isMissingReleaseTrip(row)) types.push('missing_release');
    if (isDriverCreditIssueTrip(row)) types.push('driver_credit');
    if (isPayoutMismatchTrip(row)) types.push('payout');
    if (isWalletMismatchTrip(row) && !isDriverCreditIssueTrip(row)) types.push('wallet_mismatch');
    if (isCaptureMismatchTrip(row)
      && !isShortfallTrip(row)
      && !isMissingCaptureTrip(row)) {
      types.push('capture_mismatch');
    }

    if (types.length === 0) continue;

    for (const type of types) {
      const { expected, actual, difference } = expectedActualForIssue(type, row);
      issues.push({
        trip_id: row.trip_id,
        date: row.date ?? null,
        trip_code: row.trip_code ?? null,
        driver_id: row.driver_id ?? null,
        driver_name: row.driver_name ?? null,
        issue_type: type,
        issue_label: issueLabel(type),
        expected_pence: expected,
        actual_pence: actual,
        difference_pence: difference,
        status: type === 'driver_credit' || type === 'wallet_mismatch'
          ? (row.driver_credit_health ?? row.reconciliation_status?.label ?? row.capture_reconciliation_status ?? 'Open')
          : (row.reconciliation_status?.label
            ?? row.capture_reconciliation_status
            ?? 'Open'),
        driver_credit_health: type === 'driver_credit' || type === 'wallet_mismatch'
          ? (row.driver_credit_health ?? null)
          : null,
        is_critical: isCriticalIssue(type, row),
        is_resolved: false,
        payment_session_id: row.payment_session_id ?? null,
      });
    }
  }

  return issues;
}

export function filterFrUnifiedIssues(
  issues: FrUnifiedIssue[],
  filter: FrIssueFilter,
): FrUnifiedIssue[] {
  if (filter === 'all') {
    return issues.filter((i) => !i.is_resolved);
  }
  if (filter === 'critical') {
    return issues.filter((i) => i.is_critical && !i.is_resolved);
  }
  if (filter === 'resolved') {
    return issues.filter((i) => i.is_resolved);
  }
  if (filter === 'shortfalls') {
    return issues.filter((i) => i.issue_type === 'shortfall');
  }
  if (filter === 'missing_capture') {
    return issues.filter((i) => i.issue_type === 'missing_capture');
  }
  if (filter === 'missing_release') {
    return issues.filter((i) => i.issue_type === 'missing_release');
  }
  if (filter === 'driver_credit') {
    return issues.filter((i) => i.issue_type === 'driver_credit' || i.issue_type === 'wallet_mismatch');
  }
  if (filter === 'payout') {
    return issues.filter((i) => i.issue_type === 'payout');
  }
  return issues;
}

/** Narrow Issues tab to specific trip codes (e.g. missing entitlement stamps). */
export function filterFrUnifiedIssuesByTripCodes(
  issues: FrUnifiedIssue[],
  tripCodes: string[],
): FrUnifiedIssue[] {
  const codes = new Set(
    tripCodes.map((code) => code.trim().toUpperCase()).filter(Boolean),
  );
  if (codes.size === 0) return issues;
  return issues.filter(
    (issue) => issue.trip_code && codes.has(String(issue.trip_code).trim().toUpperCase()),
  );
}

/** Supplement Issues when stamp-verification trips fall outside the selected audit period. */
export function buildFrMissingStampVerificationIssues(args: {
  tripCodes: string[];
  driverId?: string | null;
  driverName?: string | null;
  missingStampTrips?: Array<{
    trip_id: string | null;
    trip_code: string | null;
    wallet_credit_pence: number;
  }> | null;
  existingIssues: FrUnifiedIssue[];
}): FrUnifiedIssue[] {
  const wanted = new Set(
    args.tripCodes.map((code) => code.trim().toUpperCase()).filter(Boolean),
  );
  if (wanted.size === 0) return [];

  const existingCodes = new Set(
    args.existingIssues
      .map((issue) => issue.trip_code?.trim().toUpperCase())
      .filter(Boolean),
  );

  const byCode = new Map(
    (args.missingStampTrips ?? [])
      .filter((trip) => trip.trip_code?.trim())
      .map((trip) => [trip.trip_code!.trim().toUpperCase(), trip]),
  );

  const supplemental: FrUnifiedIssue[] = [];
  for (const code of wanted) {
    if (existingCodes.has(code)) continue;
    const trip = byCode.get(code);
    supplemental.push({
      trip_id: trip?.trip_id ?? code,
      date: null,
      trip_code: trip?.trip_code ?? code,
      driver_id: args.driverId ?? null,
      driver_name: args.driverName ?? null,
      issue_type: 'driver_credit',
      issue_label: 'Driver credit',
      expected_pence: null,
      actual_pence: trip?.wallet_credit_pence ?? null,
      difference_pence: null,
      status: 'EXPECTED_STAMP_MISSING',
      driver_credit_health: 'MISSING',
      is_critical: false,
      is_resolved: false,
      payment_session_id: null,
    });
  }
  return supplemental;
}

export function filterFrUnifiedIssuesByDriverId(
  issues: FrUnifiedIssue[],
  driverId: string | null | undefined,
): FrUnifiedIssue[] {
  const id = driverId?.trim();
  if (!id) return issues;
  return issues.filter((issue) => issue.driver_id === id);
}

export function countFrIssuesByFilter(issues: FrUnifiedIssue[]): Record<FrIssueFilter, number> {
  const counts = {} as Record<FrIssueFilter, number>;
  for (const filter of FR_ISSUE_FILTERS) {
    counts[filter] = filterFrUnifiedIssues(issues, filter).length;
  }
  return counts;
}

export type TripReconciliationDisplayStatus = 'Reconciled' | 'Pending' | 'Issue';

/** Simplified trip status for the Trips tab. */
export function resolveTripReconciliationDisplayStatus(row: FrIssueTripRow): TripReconciliationDisplayStatus {
  if (isResolvedTrip(row)) return 'Reconciled';

  const label = String(row.reconciliation_status?.label ?? '').toLowerCase();
  const capture = String(row.capture_reconciliation_status ?? '').toLowerCase();
  const release = String(row.release_reconciliation_status ?? '').toLowerCase();

  if (
    label.includes('pending')
    || label.includes('sync')
    || label.includes('awaiting')
    || capture.includes('pending')
    || capture.includes('unknown')
    || release.includes('pending')
    || release.includes('unknown')
  ) {
    if (!isShortfallTrip(row)
      && !isMissingCaptureTrip(row)
      && !isMissingReleaseTrip(row)
      && !isDriverCreditIssueTrip(row)
      && !isPayoutMismatchTrip(row)
      && !isWalletMismatchTrip(row)
      && !row.capture_mismatch) {
      return 'Pending';
    }
  }

  if (
    isShortfallTrip(row)
    || isMissingCaptureTrip(row)
    || isMissingReleaseTrip(row)
    || isDriverCreditIssueTrip(row)
    || isPayoutMismatchTrip(row)
    || isWalletMismatchTrip(row)
    || row.capture_mismatch
    || label.includes('mismatch')
  ) {
    return 'Issue';
  }

  return 'Pending';
}
