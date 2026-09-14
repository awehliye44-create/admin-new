/**
 * A8B28F Stage C companion — pure simulation (no I/O, no deploy).
 * Run: npx tsx supabase/drafts/A8B28F_stage_c_companion/tests/phaseA8B28FStageCCompanion.simulation.ts
 * or: deno run ...
 */
import { resolvePayoutAccountBanner } from '../../../../../ONECAB/onecab-driver-native/src/features/wallet/drafts/A8B28F_stage_c_companion/resolvePayoutAccountBanner.draft.ts';
import { evaluateDriverBatchEligibilityStageC } from '../edge/weeklyDriverPayoutBatchWorkflowSSOT.draft.ts';
import { effectivePayoutAllowed, balancePresentation } from '../../A8B28F_stage_b/shared/payoutDestinationVerificationOutcomeSSOT.ts';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

// MK0006 Home banner
{
  const banner = resolvePayoutAccountBanner({
    serviceAreaFinancialModels: ['PLATFORM_COLLECTED'],
    destination: {
      hasActiveDestination: true,
      verificationStatus: 'PROVIDER_VERIFIED',
      providerLinkStatus: 'PROVIDER_VERIFIED',
      hasCounterpartyRef: true,
      hasRecipientRef: true,
      providerVerified: true,
    },
    payoutOperationalPaused: false,
    legacyPayoutsDisabled: true,
  });
  assert(banner === null, 'MK0006 must not show paused banner');
}

// Wallet presentation already live via SQL Stage C; companion must not re-zero on legacy
{
  const bal = balancePresentation({
    cleared_pence: 425,
    uncleared_pending_pence: 0,
    payout_operational_paused: false,
    effective_payout_allowed: true,
    minimum_pence: 0,
    block_reason: 'NONE',
  });
  assert(bal.available_pence === 425 && bal.withdrawable_pence === 425, 'MK0006 withdrawable');
}

// Weekly batch: OP false + verified + available → eligible even if legacy would have been false
{
  const d = evaluateDriverBatchEligibilityStageC({
    driver_id: 'mk0006',
    wallet_balance_pence: 425,
    available_payout_pence: 425,
    payout_operational_paused: false,
    driver_held_or_blocked: false,
    currency: 'GBP',
    expected_currency: 'GBP',
    destination: {
      id: 'd1',
      is_active: true,
      archived_at: null,
      provider_link_status: 'PROVIDER_VERIFIED',
      provider_counterparty_id: 'cp',
      provider_recipient_account_id: 'rc',
    },
    has_conflicting_active_item: false,
  });
  assert(d.eligible, 'batch eligible');
}

{
  const d = evaluateDriverBatchEligibilityStageC({
    driver_id: 'paused',
    wallet_balance_pence: 425,
    available_payout_pence: 0,
    payout_operational_paused: true,
    driver_held_or_blocked: false,
    currency: 'GBP',
    expected_currency: 'GBP',
    destination: {
      id: 'd1',
      is_active: true,
      archived_at: null,
      provider_link_status: 'PROVIDER_VERIFIED',
      provider_counterparty_id: 'cp',
      provider_recipient_account_id: 'rc',
    },
    has_conflicting_active_item: false,
  });
  assert(!d.eligible && d.reasons.includes('OPERATIONAL_PAUSE'), 'paused batch blocked');
}

{
  const eff = effectivePayoutAllowed({
    global_payouts_enabled: true,
    provider_verified_active_destination: true,
    payout_operational_paused: false,
    driver_approved: true,
    driver_suspended: false,
  });
  assert(eff.effective_payout_allowed, 'effective true for MK0006-like');
}

console.log('A8B28F_STAGE_C_COMPANION_SIMULATION_OK');
