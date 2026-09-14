/**
 * A8B28F Stage C companion DRAFT — onecabFinanceLedger.derivePayoutEligibility
 *
 * Revolut/manual-bank era: provider_account_id / Connect onboarding are not required.
 * Replace payouts_enabled conjunct with Stage C readiness via effectivePayoutAllowed
 * (from payoutDestinationVerificationOutcomeSSOT.ts — same file tree in _shared).
 */

export type PayoutEligibilityInputStageC = {
  provider_verified_active_destination?: boolean | null;
  payout_operational_paused?: boolean | null;
  global_payouts_enabled?: boolean | null;
  driver_approved?: boolean | null;
  driver_disabled?: boolean | null;
  /** @deprecated ignored for eligibility after companion deploy */
  payouts_enabled?: boolean | null;
};

export function derivePayoutEligibilityStageC(
  driver: PayoutEligibilityInputStageC,
  effectivePayoutAllowedFn: (input: {
    global_payouts_enabled: boolean;
    provider_verified_active_destination: boolean;
    payout_operational_paused: boolean;
    driver_approved: boolean;
    driver_suspended: boolean;
  }) => { effective_payout_allowed: boolean },
): {
  provider_connected: boolean;
  payout_eligible: boolean;
  settlement_status: 'eligible' | 'needs_attention' | 'not_connected';
} {
  const eff = effectivePayoutAllowedFn({
    global_payouts_enabled: driver.global_payouts_enabled !== false,
    provider_verified_active_destination: driver.provider_verified_active_destination === true,
    payout_operational_paused: driver.payout_operational_paused === true,
    driver_approved: driver.driver_approved !== false,
    driver_suspended: driver.driver_disabled === true,
  });

  const providerConnected = driver.provider_verified_active_destination === true;
  const payoutEligible = eff.effective_payout_allowed;

  let settlementStatus: 'eligible' | 'needs_attention' | 'not_connected' = 'not_connected';
  if (providerConnected && payoutEligible) settlementStatus = 'eligible';
  else if (providerConnected) settlementStatus = 'needs_attention';

  return {
    provider_connected: providerConnected,
    payout_eligible: payoutEligible,
    settlement_status: settlementStatus,
  };
}
