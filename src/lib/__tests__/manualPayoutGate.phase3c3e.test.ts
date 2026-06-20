import { describe, expect, it } from 'vitest';
import {
  MANUAL_PAYOUT_SOFT_WARNING_MESSAGE,
  canManualPayout,
  hasSoftPayoutWarning,
  manualPayoutSoftWarningMessage,
} from '../manualPayoutGate';
import type { PerDriverFinanceSSOT } from '@/hooks/usePerDriverFinancialReconciliation';
const PAYOUT_SOFT_WARNING_RECONCILIATION =
  "Reconciliation variance within expected timing — payouts use finance-cleared amounts";

const baseSsot: PerDriverFinanceSSOT = {
  driver_id: 'd1',
  driver_gross_earnings_pence: 0,
  driver_net_earnings_pence: 0,
  driver_paid_out_pence: 0,
  completed_early_cashouts_pence: 0,
  adjustments_pence: 0,
  driver_remaining_liability_pence: 0,
  in_flight_cashout_pence: 0,
  provider_available_balance_pence: 0,
  provider_pending_balance_pence: 0,
  provider_available_balance_allocated_to_driver_pence: 304,
  provider_upcoming_payout_pence: 0,
  driver_available_now_pence: 305,
  driver_pending_payout_pence: 0,
  next_payout_date: null,
  reconciliation_status: 'RECONCILIATION_MISMATCH',
  source_tier: 'LIVE',
  ledger_sync_missing: false,
  payout_blocked: false,
  payout_blocked_reasons: [],
  payout_warning_reasons: [PAYOUT_SOFT_WARNING_RECONCILIATION],
};

const eligibleDriver = {
  stripe_account_id: 'acct',
  onboarding_complete: true,
  payouts_enabled: true,
};

describe('manualPayoutGate Phase 3C.3e', () => {
  it('soft warning does not block manual payout', () => {
    expect(canManualPayout({ driver: eligibleDriver, ssot: baseSsot })).toBe(true);
    expect(hasSoftPayoutWarning(baseSsot)).toBe(true);
  });

  it('hard block blocks manual payout', () => {
    expect(
      canManualPayout({
        driver: eligibleDriver,
        ssot: {
          ...baseSsot,
          payout_blocked: true,
          payout_blocked_reasons: ['Ledger sync missing'],
        },
      }),
    ).toBe(false);
  });

  it('MK0001 eligibility: ready > 0, soft warning only', () => {
    const mk0001: PerDriverFinanceSSOT = {
      ...baseSsot,
      driver_id: '5ed232c3-8bb5-4085-95d6-73e48e6c5e28',
      driver_available_now_pence: 305,
      payout_blocked: false,
      payout_warning_reasons: [PAYOUT_SOFT_WARNING_RECONCILIATION],
    };
    expect(canManualPayout({ driver: eligibleDriver, ssot: mk0001 })).toBe(true);
    expect(manualPayoutSoftWarningMessage(mk0001)).toContain(MANUAL_PAYOUT_SOFT_WARNING_MESSAGE);
  });

  it('MK0002 eligibility: ready > 0, soft warning only', () => {
    const mk0002: PerDriverFinanceSSOT = {
      ...baseSsot,
      driver_id: 'cd8bae4c-3827-4b90-98c6-10be70eb0e52',
      driver_available_now_pence: 259,
      payout_blocked: false,
      payout_warning_reasons: [PAYOUT_SOFT_WARNING_RECONCILIATION],
    };
    expect(canManualPayout({ driver: eligibleDriver, ssot: mk0002 })).toBe(true);
  });

  it('in-flight payout disables manual payout', () => {
    expect(canManualPayout({ driver: eligibleDriver, ssot: baseSsot, inFlightPayout: true })).toBe(false);
  });
});
