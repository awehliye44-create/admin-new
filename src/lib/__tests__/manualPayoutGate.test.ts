import { describe, expect, it } from 'vitest';
import {
  MANUAL_PAYOUT_NO_SSOT_BALANCE_MESSAGE,
  canManualPayout,
  formatPayoutEligibilityStatus,
  isDriverStripeOnboardingComplete,
  manualPayoutBlockedHeadline,
} from '../manualPayoutGate';
import type { PerDriverFinanceSSOT } from '@/hooks/usePerDriverFinancialReconciliation';

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
  provider_available_balance_allocated_to_driver_pence: 0,
  provider_upcoming_payout_pence: 0,
  driver_available_now_pence: 0,
  driver_wallet_balance_pence: 0,
  driver_debt_pence: 0,
  driver_pending_payout_pence: 0,
  next_payout_date: null,
  reconciliation_status: 'BALANCED',
  source_tier: 'LIVE',
  ledger_sync_missing: false,
  payout_blocked: false,
  payout_blocked_reasons: [],
  payout_warning_reasons: [],
};

describe('manualPayoutGate', () => {
  it('uses SSOT no-balance message when available_now is zero', () => {
    expect(
      manualPayoutBlockedHeadline({ ssot: baseSsot, canPayout: false }),
    ).toBe(MANUAL_PAYOUT_NO_SSOT_BALANCE_MESSAGE);
  });

  it('blocks manual payout when available_now is zero', () => {
    expect(
      canManualPayout({
        driver: {
          stripe_account_id: 'acct',
          onboarding_complete: true,
          payouts_enabled: true,
        },
        ssot: baseSsot,
      }),
    ).toBe(false);
  });

  it('allows manual payout without Stripe Connect account when SSOT gates pass', () => {
    expect(
      canManualPayout({
        driver: {
          stripe_account_id: null,
          onboarding_complete: false,
          payouts_enabled: true,
        },
        ssot: { ...baseSsot, driver_available_now_pence: 500 },
      }),
    ).toBe(true);
  });

  it('blocks manual payout when wallet balance is negative', () => {
    expect(
      canManualPayout({
        driver: {
          stripe_account_id: 'acct',
          onboarding_complete: true,
          payouts_enabled: true,
        },
        ssot: { ...baseSsot, driver_wallet_balance_pence: -278, driver_debt_pence: 278 },
      }),
    ).toBe(false);
    expect(
      formatPayoutEligibilityStatus({
        driver: {
          stripe_account_id: 'acct',
          onboarding_complete: true,
          payouts_enabled: true,
        },
        ssot: { ...baseSsot, driver_wallet_balance_pence: -278, driver_debt_pence: 278 },
      }),
    ).toBe('Blocked — Driver In Debt');
  });

  it('labels eligibility when payouts enabled but no SSOT balance', () => {
    expect(
      formatPayoutEligibilityStatus({
        driver: {
          stripe_account_id: null,
          onboarding_complete: false,
          payouts_enabled: true,
        },
        ssot: baseSsot,
      }),
    ).toBe('No SSOT Available Balance');
  });

  it('isDriverStripeOnboardingComplete follows payouts_enabled only (Stripe retired)', () => {
    expect(
      isDriverStripeOnboardingComplete({
        stripe_account_id: null,
        onboarding_complete: false,
        payouts_enabled: true,
      }),
    ).toBe(true);
    expect(
      isDriverStripeOnboardingComplete({
        stripe_account_id: 'acct_1',
        onboarding_complete: true,
        payouts_enabled: false,
      }),
    ).toBe(false);
  });
});
