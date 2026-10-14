import { describe, expect, it } from 'vitest';
import {
  buildFrUnifiedIssues,
  countFrIssuesByFilter,
  filterFrUnifiedIssues,
  FR_COUNTED_RELEASE_EXCEPTION_STATUSES,
  FR_RELEASE_EXCEPTION_STATUSES,
  resolveFrHeadlineStatuses,
  resolveFrTabBadgeCounts,
  type FrIssueTripRow,
} from '../../../shared/frIssuesSSOT';

function releaseTrip(status: string): FrIssueTripRow {
  return {
    trip_id: `trip-${status}`,
    trip_code: 'MK-261007-002',
    date: '2026-10-07T19:08:16Z',
    driver_id: 'driver-mk0006',
    driver_name: 'BOSTEYO Mohamed Adow',
    capture_mismatch: false,
    captured_pence: 550,
    ps_expected_capture_pence: 550,
    authorised_pence: 800,
    released_pence: null,
    reconciliation_status: { label: 'Balanced', tone: 'green' },
    release_reconciliation_status: status,
  };
}

describe('release exceptions stay visible in the Issues count', () => {
  it('classifies every release exception, including a row labelled Balanced', () => {
    for (const status of FR_RELEASE_EXCEPTION_STATUSES) {
      const issues = buildFrUnifiedIssues([releaseTrip(status)]);
      const open = filterFrUnifiedIssues(issues, 'all');
      const releaseIssues = open.filter((issue) => issue.issue_type === 'missing_release');
      expect(releaseIssues).toHaveLength(1);
      expect(releaseIssues[0]?.is_resolved).toBe(false);
      expect(releaseIssues[0]?.status).toBe(status);
      expect(releaseIssues[0]?.expected_pence).toBe(250);
      expect(releaseIssues[0]?.actual_pence).toBeNull();
      expect(countFrIssuesByFilter(issues).missing_release).toBe(1);
      expect(countFrIssuesByFilter(issues).all).toBe(open.length);
    }
  });

  it('lists every release status that the server Issues count includes', () => {
    const rows = FR_COUNTED_RELEASE_EXCEPTION_STATUSES.map((status) => releaseTrip(status));
    const issues = buildFrUnifiedIssues(rows);
    const open = filterFrUnifiedIssues(issues, 'all');
    for (const status of FR_COUNTED_RELEASE_EXCEPTION_STATUSES) {
      expect(open.some((issue) => (
        issue.status === status
        && issue.issue_type === 'missing_release'
        && !issue.is_resolved
      ))).toBe(true);
    }
    const counts = resolveFrTabBadgeCounts({
      tripAuditRows: rows,
      unifiedOpenIssueCount: open.length,
      auditOverviewKpis: {
        trip_count: rows.length,
        unresolved_mismatches_count: rows.length,
      },
    });
    expect(counts.openIssueCount).toBe(open.length);
    expect(counts.openIssueCount).toBe(FR_COUNTED_RELEASE_EXCEPTION_STATUSES.length);
  });

  it('does not advertise a KPI count the loaded issue list cannot show', () => {
    const balanced: FrIssueTripRow = {
      trip_id: 'trip-balanced',
      trip_code: 'MK-001',
      capture_mismatch: false,
      captured_pence: 550,
      reconciliation_status: { label: 'Balanced', tone: 'green' },
      release_reconciliation_status: 'RELEASE_MATCHED',
    };
    const counts = resolveFrTabBadgeCounts({
      tripAuditRows: [balanced],
      unifiedOpenIssueCount: filterFrUnifiedIssues(buildFrUnifiedIssues([balanced]), 'all').length,
      auditOverviewKpis: { trip_count: 1, unresolved_mismatches_count: 1 },
    });
    expect(counts.openIssueCount).toBe(0);
  });
});

describe('page status wiring', () => {
  it('withholds a balanced chip until release evidence has loaded', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const page = readFileSync(resolve(__dirname, '../../pages/FinancialReconciliation.tsx'), 'utf8');
    const classifier = readFileSync(resolve(__dirname, '../../../shared/frIssuesSSOT.ts'), 'utf8');
    expect(page).toContain('releaseEvidence');
    expect(page).toContain('reconciliationHeadline?.earnings');
    expect(page).toContain("new Set(['trips', 'issues'])");
    expect(classifier).toContain('RELEASE_EVIDENCE_UNAVAILABLE');
    expect(classifier).toContain("earningsStatus === 'BALANCED' ? null");
  });
});

describe('resolveFrHeadlineStatuses', () => {
  it('qualifies earnings and asks for attention while a release is unverified', () => {
    expect(resolveFrHeadlineStatuses({
      earningsStatus: 'BALANCED',
      releaseExceptionCount: 1,
      releaseEvidence: 'loaded',
    })).toEqual({
      earnings: 'EARNINGS_BALANCED',
      release: 'RELEASE_UNVERIFIED',
    });
  });

  it('leaves a bare BALANCED chip only after a clean loaded release audit', () => {
    expect(resolveFrHeadlineStatuses({
      earningsStatus: 'BALANCED',
      releaseExceptionCount: 0,
      releaseEvidence: 'loaded',
    })).toEqual({
      earnings: 'BALANCED',
      release: null,
    });
  });

  it('keeps an earnings mismatch separate from the release status', () => {
    expect(resolveFrHeadlineStatuses({
      earningsStatus: 'RECONCILIATION_MISMATCH',
      releaseExceptionCount: 2,
      releaseEvidence: 'loaded',
    })).toEqual({
      earnings: 'RECONCILIATION_MISMATCH',
      release: 'RELEASE_UNVERIFIED',
    });
  });

  it('does not show balanced when release evidence has not loaded or failed', () => {
    for (const releaseEvidence of ['not_loaded', 'failed'] as const) {
      expect(resolveFrHeadlineStatuses({
        earningsStatus: 'BALANCED',
        releaseExceptionCount: 0,
        releaseEvidence,
      })).toEqual({
        earnings: null,
        release: 'RELEASE_EVIDENCE_UNAVAILABLE',
      });
    }
  });
});
