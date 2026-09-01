import { describe, expect, it } from 'vitest';
import {
  isPayoutLedgerActiveItem,
  isPayoutLedgerHistoryItem,
  itemMatchesPayoutLedgerLifecycleTab,
} from '../../../shared/payoutLedgerNavigationSSOT';

describe('payoutLedgerNavigationSSOT', () => {
  it('treats completed payouts as history only', () => {
    expect(isPayoutLedgerHistoryItem({ status: 'completed', completed_at: '2026-01-01T00:00:00Z' })).toBe(true);
    expect(isPayoutLedgerActiveItem({ status: 'completed', completed_at: '2026-01-01T00:00:00Z' })).toBe(false);
  });

  it('keeps scheduled and reserved payouts in active lifecycle', () => {
    expect(isPayoutLedgerActiveItem({ status: 'scheduled' })).toBe(true);
    expect(isPayoutLedgerActiveItem({ status: 'reserved', display_status: 'RESERVED' })).toBe(true);
    expect(isPayoutLedgerActiveItem({ status: 'processing' })).toBe(true);
    expect(isPayoutLedgerActiveItem({ status: 'failed' })).toBe(true);
  });

  it('excludes completed from overview tab filter', () => {
    expect(itemMatchesPayoutLedgerLifecycleTab({
      tab: 'overview',
      status: 'completed',
      completed_at: '2026-01-01T00:00:00Z',
    })).toBe(false);
    expect(itemMatchesPayoutLedgerLifecycleTab({
      tab: 'overview',
      status: 'scheduled',
    })).toBe(true);
  });

  it('includes completed only on history tabs', () => {
    expect(itemMatchesPayoutLedgerLifecycleTab({
      tab: 'history',
      status: 'completed',
      completed_at: '2026-01-01T00:00:00Z',
    })).toBe(true);
  });
});
