import { describe, expect, it } from 'vitest';
import {
  classifyFinanceMismatch,
  FINANCE_ALERT_SPEC_LABELS,
  isFailedRecoveryMismatch,
} from '@/lib/financeAlertClassification';

describe('financeAlertClassification', () => {
  it('exposes exactly 8 spec alert labels', () => {
    expect(FINANCE_ALERT_SPEC_LABELS).toHaveLength(8);
    expect(FINANCE_ALERT_SPEC_LABELS).toContain('Provider without Ledger');
    expect(FINANCE_ALERT_SPEC_LABELS).toContain('Webhook failure');
  });

  it('does not flag generic recovery debt as failed recovery', () => {
    expect(
      isFailedRecoveryMismatch({
        kind: 'account_balance',
        message: 'Cash commission recovery debt outstanding',
      }),
    ).toBe(false);
  });

  it('flags explicit failed recovery', () => {
    expect(
      isFailedRecoveryMismatch({
        kind: 'failed_recovery',
        message: 'Debt recovery could not complete',
      }),
    ).toBe(true);
    expect(
      isFailedRecoveryMismatch({
        message: 'Failed recovery on trip capture',
      }),
    ).toBe(true);
  });

  it('classifies Provider without Ledger from payout mismatch', () => {
    expect(
      classifyFinanceMismatch({
        kind: 'payout',
        reference_id: 'po_1',
        message: 'Provider payout paid but no matching driver_wallet_ledger stripe_payout_id entry.',
      })?.label,
    ).toBe('Provider without Ledger');
  });

  it('classifies Ledger without Provider from payout mismatch', () => {
    expect(
      classifyFinanceMismatch({
        kind: 'payout',
        reference_id: 'po_2',
        message: 'Ledger debit does not match driver wallet ledger stripe payout.',
      })?.label,
    ).toBe('Ledger without Provider');
  });

  it('classifies duplicate payout', () => {
    expect(
      classifyFinanceMismatch({
        kind: 'payout',
        reference_id: 'po_3',
        message: 'Duplicate payout detected for driver',
      })?.label,
    ).toBe('Duplicate payout');
  });

  it('returns null for unclassified mismatches', () => {
    expect(
      classifyFinanceMismatch({
        kind: 'account_balance',
        message: 'Connect balance differs from wallet liability',
      }),
    ).toBeNull();
  });
});
