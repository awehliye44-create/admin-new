import { describe, expect, it } from 'vitest';
import {
  buildPayoutGateReasons,
} from '../../../supabase/functions/_shared/perDriverFinancialReconciliation.ts';
import {
  classifyReconciliationVariance,
  PAYOUT_SOFT_WARNING_RECONCILIATION,
} from '../../../supabase/functions/_shared/financialReconciliationSSOT.ts';
import { ledgerTypeForBatchKind } from '../../../supabase/functions/_shared/payoutLedgerSync.ts';

const MK_REGION = '7f611e59-a9e5-42c2-b65a-61376910bb5d';

describe('weekly batch gate (Phase 3C.3e)', () => {
  it('includes soft-warning drivers (hard block empty)', () => {
    const gate = buildPayoutGateReasons({
      reconciliationStatus: 'RECONCILIATION_MISMATCH',
      reconciliationVariancePence: 2787,
      sourceTier: 'LIVE',
      regionId: MK_REGION,
      providerAllocatedPence: 304,
      ledgerSyncMissing: false,
      availableNowPence: 305,
    });
    expect(gate.payout_blocked_reasons).toEqual([]);
    expect(gate.payout_warning_reasons.length).toBeGreaterThan(0);
  });

  it('skips hard-blocked drivers', () => {
    const gate = buildPayoutGateReasons({
      reconciliationStatus: 'RECONCILIATION_MISMATCH',
      reconciliationVariancePence: -500,
      sourceTier: 'LIVE',
      regionId: MK_REGION,
      providerAllocatedPence: 304,
      ledgerSyncMissing: false,
      availableNowPence: 305,
    });
    expect(gate.payout_blocked_reasons.length).toBeGreaterThan(0);
  });
});

describe('MK driver gate fixtures (audit targets)', () => {
  it('MK0001: ~305p ready, soft warning only', () => {
    const gate = buildPayoutGateReasons({
      reconciliationStatus: 'RECONCILIATION_MISMATCH',
      reconciliationVariancePence: 2787,
      sourceTier: 'LIVE',
      regionId: MK_REGION,
      providerAllocatedPence: 304,
      ledgerSyncMissing: false,
      availableNowPence: 305,
    });
    expect(gate.payout_blocked_reasons).toEqual([]);
    expect(gate.payout_warning_reasons.length).toBeGreaterThan(0);
  });

  it('MK0002: ~259p ready, soft warning only', () => {
    const gate = buildPayoutGateReasons({
      reconciliationStatus: 'RECONCILIATION_MISMATCH',
      reconciliationVariancePence: 2787,
      sourceTier: 'LIVE',
      regionId: MK_REGION,
      providerAllocatedPence: 260,
      ledgerSyncMissing: false,
      availableNowPence: 259,
    });
    expect(gate.payout_blocked_reasons).toEqual([]);
    expect(gate.payout_warning_reasons.length).toBeGreaterThan(0);
  });
});

describe('payout ledger debit type', () => {
  it('manual admin payout uses MANUAL_PAYOUT not PAYOUT_SENT', () => {
    expect(ledgerTypeForBatchKind('MANUAL_ADMIN')).toBe('MANUAL_PAYOUT');
  });

  it('weekly monday uses WEEKLY_PAYOUT', () => {
    expect(ledgerTypeForBatchKind('WEEKLY_MONDAY')).toBe('WEEKLY_PAYOUT');
  });
});

describe('classifyReconciliationVariance', () => {
  it('MK positive mismatch is soft', () => {
    expect(
      classifyReconciliationVariance({
        reconciliationStatus: 'RECONCILIATION_MISMATCH',
        variancePence: 2787,
        sourceTier: 'LIVE',
        regionId: MK_REGION,
      }),
    ).toBe('soft_positive_classified');
  });
});
