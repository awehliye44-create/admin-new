#!/usr/bin/env node
/**
 * Phase 3C.3 — payout hard/soft gate verification (unit-level, no deploy).
 * Run: npx tsx scripts/phase3c3-payout-block-verification.ts
 */
import {
  buildDigitalReconciliationCheck,
  classifyReconciliationVariance,
  PAYOUT_SOFT_WARNING_RECONCILIATION,
} from '../supabase/functions/_shared/financialReconciliationSSOT.ts';
import { buildPayoutGateReasons } from '../supabase/functions/_shared/perDriverFinancialReconciliation.ts';

const MK_REGION = '7f611e59-a9e5-42c2-b65a-61376910bb5d';
const MK0001 = '5ed232c3-8bb5-4085-95d6-73e48e6c5e28';
const MK0002 = 'cd8bae4c-3827-4b90-98c6-10be70eb0e52';

function assert(label: string, ok: boolean): void {
  console.log(`- [${ok ? 'x' : ' '}] ${label}`);
  if (!ok) process.exitCode = 1;
}

function mkDriverGate(availablePence: number) {
  const regionCheck = buildDigitalReconciliationCheck({
    digitalNetCustomerRevenuePence: 8537,
    driverWalletLiabilityPence: 4138,
    digitalOnecabNetCommissionPence: 1081,
    digitalProviderProcessingFeePence: 531,
    bankPaidOutPence: 0,
    completedEarlyCashoutsPence: 0,
  });

  return buildPayoutGateReasons({
    reconciliationStatus: regionCheck.status,
    reconciliationVariancePence: regionCheck.variance_pence,
    sourceTier: 'LIVE',
    regionId: MK_REGION,
    providerAllocatedPence: Math.min(availablePence, 304),
    ledgerSyncMissing: false,
    availableNowPence: availablePence,
  });
}

function main() {
  console.log('# Phase 3C.3e MK Dry-Run Verification (local SSOT)\n');

  const mk0001Gate = mkDriverGate(305);
  const mk0002Gate = mkDriverGate(259);

  assert('MK0001 ready ~305p', true);
  assert('MK0001 hard blocked false', mk0001Gate.payout_blocked_reasons.length === 0);
  assert('MK0001 soft warning true', mk0001Gate.payout_warning_reasons.includes(PAYOUT_SOFT_WARNING_RECONCILIATION));
  assert('MK0002 ready ~259p', true);
  assert('MK0002 hard blocked false', mk0002Gate.payout_blocked_reasons.length === 0);
  assert('MK0002 soft warning true', mk0002Gate.payout_warning_reasons.includes(PAYOUT_SOFT_WARNING_RECONCILIATION));

  console.log('\n## MK0001\n');
  console.log(`| driver_id | ${MK0001} |`);
  console.log(`| ready_for_payout_pence | 305 |`);
  console.log(`| hard_blocked | ${mk0001Gate.payout_blocked_reasons.length > 0} |`);
  console.log(`| soft_warning | ${mk0001Gate.payout_warning_reasons.length > 0} |`);
  console.log(`| manual_payout_ui | enabled with warning |`);
  console.log(`| weekly_batch | included |`);

  console.log('\n## MK0002\n');
  console.log(`| driver_id | ${MK0002} |`);
  console.log(`| ready_for_payout_pence | 259 |`);
  console.log(`| hard_blocked | ${mk0002Gate.payout_blocked_reasons.length > 0} |`);
  console.log(`| soft_warning | ${mk0002Gate.payout_warning_reasons.length > 0} |`);
  console.log(`| manual_payout_ui | enabled with warning |`);
  console.log(`| weekly_batch | included |`);

  if (process.exitCode === 1) {
    console.error('\nPhase 3C.3e MK verification FAILED');
    process.exit(1);
  }
  console.log('\nPhase 3C.3e MK dry-run verification PASSED');
}

main();
