import { describe, expect, it } from 'vitest';
import {
  buildFrUnifiedIssues,
  buildFrMissingStampVerificationIssues,
  countFrIssuesByFilter,
  filterFrUnifiedIssues,
  filterFrUnifiedIssuesByTripCodes,
  hasFrPeriodAuditKpis,
  parseFrIssueFilter,
  parseFrTripFilter,
  resolveFrDriverCreditBanner,
  resolveFrTabBadgeCounts,
  resolveLegacyFrTabIssueFilter,
  financialReconciliationLegacyTabRedirect,
  resolveTripReconciliationDisplayStatus,
  type FrIssueTripRow,
} from '../frIssuesSSOT';

const balancedTrip: FrIssueTripRow = {
  trip_id: 'trip-balanced',
  trip_code: 'MK-001',
  date: '2026-08-01T12:00:00Z',
  driver_id: 'driver-1',
  driver_name: 'Alex',
  capture_mismatch: false,
  reconciliation_status: { label: 'Balanced', tone: 'green' },
  captured_pence: 1000,
  ps_expected_capture_pence: 1000,
};

const shortfallTrip: FrIssueTripRow = {
  trip_id: 'trip-shortfall',
  trip_code: 'MK-002',
  date: '2026-08-02T12:00:00Z',
  driver_id: 'driver-2',
  driver_name: 'Sam',
  payment_method: 'card',
  capture_reconciliation_status: 'CAPTURE_SHORTFALL',
  capture_variance_pence: -250,
  outstanding_pence: 250,
  ps_expected_capture_pence: 1000,
  captured_pence: 750,
  reconciliation_status: { label: 'Capture mismatch', tone: 'red' },
};

const driverCreditTrip: FrIssueTripRow = {
  trip_id: 'trip-credit',
  trip_code: 'MK-003',
  date: '2026-08-03T12:00:00Z',
  driver_id: 'driver-3',
  driver_name: 'Jo',
  driver_credit_health: 'UNDER_CREDITED',
  expected_driver_credit_pence: 800,
  actual_driver_credit_pence: 600,
  credit_difference_pence: -200,
  reconciliation_status: { label: 'Wallet mismatch', tone: 'red' },
};

describe('parseFrIssueFilter', () => {
  it('defaults to all', () => {
    expect(parseFrIssueFilter(null)).toBe('all');
    expect(parseFrIssueFilter('unknown')).toBe('all');
  });

  it('parses known filters', () => {
    expect(parseFrIssueFilter('driver_credit')).toBe('driver_credit');
    expect(parseFrIssueFilter('resolved')).toBe('resolved');
  });
});

describe('parseFrTripFilter', () => {
  it('parses driver credit trip filter only', () => {
    expect(parseFrTripFilter('driver_credit')).toBe('driver_credit');
    expect(parseFrTripFilter(null)).toBeNull();
    expect(parseFrTripFilter('all')).toBeNull();
  });
});

describe('resolveLegacyFrTabIssueFilter', () => {
  it('maps removed tabs to issue filters', () => {
    expect(resolveLegacyFrTabIssueFilter('shortfall')).toBe('shortfalls');
    expect(resolveLegacyFrTabIssueFilter('wallet_mismatches')).toBe('driver_credit');
    expect(resolveLegacyFrTabIssueFilter('history')).toBe('resolved');
    expect(resolveLegacyFrTabIssueFilter('overview')).toBeNull();
  });
});

describe('buildFrUnifiedIssues', () => {
  it('emits resolved rows separately from open issues', () => {
    const issues = buildFrUnifiedIssues([balancedTrip, shortfallTrip, driverCreditTrip]);
    expect(issues.some((i) => i.is_resolved && i.trip_id === 'trip-balanced')).toBe(true);
    expect(issues.some((i) => i.issue_type === 'shortfall')).toBe(true);
    expect(issues.some((i) => i.issue_type === 'driver_credit')).toBe(true);
  });

  it('filter counts match visible rows', () => {
    const issues = buildFrUnifiedIssues([balancedTrip, shortfallTrip, driverCreditTrip]);
    const counts = countFrIssuesByFilter(issues);
    expect(counts.all).toBe(filterFrUnifiedIssues(issues, 'all').length);
    expect(counts.shortfalls).toBe(filterFrUnifiedIssues(issues, 'shortfalls').length);
    expect(counts.driver_credit).toBe(filterFrUnifiedIssues(issues, 'driver_credit').length);
    expect(counts.resolved).toBe(filterFrUnifiedIssues(issues, 'resolved').length);
  });

  it('critical filter excludes resolved trips', () => {
    const issues = buildFrUnifiedIssues([balancedTrip, shortfallTrip]);
    const critical = filterFrUnifiedIssues(issues, 'critical');
    expect(critical.every((i) => !i.is_resolved)).toBe(true);
    expect(critical.some((i) => i.trip_id === 'trip-shortfall')).toBe(true);
  });
});

describe('resolveTripReconciliationDisplayStatus', () => {
  it('maps balanced trips to Reconciled', () => {
    expect(resolveTripReconciliationDisplayStatus(balancedTrip)).toBe('Reconciled');
  });

  it('maps open mismatches to Issue', () => {
    expect(resolveTripReconciliationDisplayStatus(shortfallTrip)).toBe('Issue');
    expect(resolveTripReconciliationDisplayStatus(driverCreditTrip)).toBe('Issue');
  });
});

describe('financialReconciliationLegacyTabRedirect', () => {
  it('builds issues tab URLs for removed tabs', () => {
    expect(financialReconciliationLegacyTabRedirect('shortfall')).toBe(
      '/financial-reconciliation?tab=issues&issueFilter=shortfalls',
    );
    expect(financialReconciliationLegacyTabRedirect('overview')).toBeNull();
  });
});

describe('resolveFrTabBadgeCounts', () => {
  it('falls back to meta trip count when summary-only audit KPIs are empty', () => {
    const counts = resolveFrTabBadgeCounts({
      tripAuditRows: [],
      unifiedOpenIssueCount: 0,
      auditOverviewKpis: { trip_count: 0, unresolved_mismatches_count: 0 },
      metaTripCount: 12,
    });
    expect(counts.periodTripCount).toBe(12);
    expect(counts.openIssueCount).toBe(0);
  });

  it('falls back to summary KPIs when audit KPIs are populated', () => {
    const counts = resolveFrTabBadgeCounts({
      tripAuditRows: [],
      unifiedOpenIssueCount: 0,
      auditOverviewKpis: { trip_count: 12, unresolved_mismatches_count: 3 },
    });
    expect(counts.periodTripCount).toBe(12);
    expect(counts.openIssueCount).toBe(3);
  });

  it('prefers loaded audit rows over KPIs', () => {
    const issues = buildFrUnifiedIssues([balancedTrip, shortfallTrip]);
    const counts = resolveFrTabBadgeCounts({
      tripAuditRows: [balancedTrip, shortfallTrip],
      unifiedOpenIssueCount: filterFrUnifiedIssues(issues, 'all').length,
      auditOverviewKpis: { trip_count: 99, unresolved_mismatches_count: 99 },
    });
    expect(counts.periodTripCount).toBe(2);
    expect(counts.openIssueCount).toBe(1);
  });
});

describe('resolveFrDriverCreditBanner', () => {
  it('does not treat empty summary-only KPIs as driver credit evidence', () => {
    const banner = resolveFrDriverCreditBanner({
      tripAuditRows: [],
      tripAgg: { exception_trip_count: 0, total_difference_pence: 0 },
      auditOverviewKpis: { trip_count: 0, driver_credit_exception_trip_count: 2 },
    });
    expect(banner.exception_trip_count).toBe(0);
  });

  it('uses KPI fallback when audit KPIs are populated', () => {
    const banner = resolveFrDriverCreditBanner({
      tripAuditRows: [],
      tripAgg: { exception_trip_count: 0, total_difference_pence: 0 },
      auditOverviewKpis: {
        driver_credit_exception_trip_count: 2,
        driver_credit_exception_difference_pence: 150,
      },
    });
    expect(banner.exception_trip_count).toBe(2);
    expect(banner.total_difference_pence).toBe(150);
  });
});

describe('hasFrPeriodAuditKpis', () => {
  it('is false for summary-only zeroed KPI objects', () => {
    expect(hasFrPeriodAuditKpis({ trip_count: 0, unresolved_mismatches_count: 0 })).toBe(false);
    expect(hasFrPeriodAuditKpis(null)).toBe(false);
  });

  it('is true when trip_count is positive', () => {
    expect(hasFrPeriodAuditKpis({ trip_count: 4 })).toBe(true);
  });
});

describe('missing stamp verification issues', () => {
  it('filters issues by trip code', () => {
    const issues = buildFrUnifiedIssues([shortfallTrip, driverCreditTrip]);
    const filtered = filterFrUnifiedIssuesByTripCodes(issues, ['MK-003']);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.trip_code).toBe('MK-003');
  });

  it('supplements stamp-verification trips missing from period audit rows', () => {
    const base = buildFrUnifiedIssues([balancedTrip]);
    const supplemental = buildFrMissingStampVerificationIssues({
      tripCodes: ['MK-260817-008', 'MK-260815-029'],
      driverId: 'driver-2',
      driverName: 'Asiya',
      missingStampTrips: [
        { trip_id: 't1', trip_code: 'MK-260817-008', wallet_credit_pence: 609 },
        { trip_id: 't2', trip_code: 'MK-260815-029', wallet_credit_pence: 835 },
      ],
      existingIssues: base,
    });
    expect(supplemental).toHaveLength(2);
    expect(supplemental.every((issue) => issue.status === 'EXPECTED_STAMP_MISSING')).toBe(true);
    expect(supplemental.reduce((sum, issue) => sum + (issue.actual_pence ?? 0), 0)).toBe(1444);
  });
});
