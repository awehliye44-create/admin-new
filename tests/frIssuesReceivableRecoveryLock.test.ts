/**
 * Lock: SETTLED receivable recovery is resolved evidence — not an open shortfall.
 */
import { describe, expect, it } from 'vitest';
import {
  buildFrUnifiedIssues,
  isShortfallTrip,
  type FrIssueTripRow,
} from '../shared/frIssuesSSOT';

const FR_RESOLVED_BY_RECEIVABLE_RECOVERY = 'RESOLVED_BY_RECEIVABLE_RECOVERY';

describe('frIssues receivable recovery classification', () => {
  it('6. Historical decline remains visible as resolved evidence; excluded from open shortfalls', () => {
    const row: FrIssueTripRow = {
      trip_id: '2799bb97-cabf-47e1-a570-fe225e6b06b1',
      trip_code: 'MK-260923-012',
      capture_reconciliation_status: 'CAPTURE_SHORTFALL',
      capture_variance_pence: -30,
      outstanding_pence: 0,
      captured_pence: 549,
      reconciliation_status: { label: 'SETTLEMENT_MISMATCH', tone: 'red' },
      resolved_by_receivable_recovery: true,
      receivable_recovery_status: FR_RESOLVED_BY_RECEIVABLE_RECOVERY,
      settled_receivable_original_pence: 30,
      recovery_payment_session_id: '6d86b1e6-4b02-4059-8da4-753717721ffe',
    };
    expect(isShortfallTrip(row)).toBe(false);
    const issues = buildFrUnifiedIssues([row]);
    expect(issues).toHaveLength(1);
    expect(issues[0].is_resolved).toBe(true);
    expect(issues[0].status).toBe(FR_RESOLVED_BY_RECEIVABLE_RECOVERY);
    expect(issues[0].difference_pence).toBe(30);
    expect(issues[0].issue_label).toContain('receivable recovery');
  });
});
