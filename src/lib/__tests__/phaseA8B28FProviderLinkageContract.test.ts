/**
 * A8B28F Stage B2 — provider outcome / response contract (no provider I/O).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PAYOUT_DESTINATION_OUTCOME,
  PROVIDER_LINK_FAILURE_CLASS,
  classifyCounterpartyCreateFailure,
  httpStatusForOutcome,
  isClientSuccessOutcome,
  resolveSyncUkRevolutOutcome,
} from '../../../supabase/functions/_shared/payoutDestinationVerificationOutcomeSSOT';
import { interpretCompat } from '../../../supabase/drafts/A8B28F_stage_b/tests/compatHarness';

const ROOT = resolve(__dirname, '../../..');
const HANDLER = resolve(
  ROOT,
  'supabase/functions/_shared/updateDriverPayoutDestinationHandler.ts',
);

describe('phase A8B28F Stage B2 provider linkage contract', () => {
  const handler = readFileSync(HANDLER, 'utf8');

  it('maps sync outcomes to required HTTP statuses', () => {
    expect(httpStatusForOutcome(PAYOUT_DESTINATION_OUTCOME.DESTINATION_SAVED_AND_VERIFIED)).toBe(200);
    expect(httpStatusForOutcome(PAYOUT_DESTINATION_OUTCOME.DESTINATION_ALREADY_VERIFIED)).toBe(200);
    expect(httpStatusForOutcome(PAYOUT_DESTINATION_OUTCOME.DESTINATION_SAVED_VERIFICATION_PENDING)).toBe(202);
    expect(httpStatusForOutcome(PAYOUT_DESTINATION_OUTCOME.DESTINATION_SAVED_VERIFICATION_FAILED)).toBe(422);
    expect(httpStatusForOutcome(PAYOUT_DESTINATION_OUTCOME.RETRY_REQUIRED)).toBe(422);
  });

  it('create failure is never client success', () => {
    const o = resolveSyncUkRevolutOutcome({
      saveOk: true,
      linkStatus: 'FAILED',
      verificationStatus: 'PENDING_VERIFICATION',
      hasCounterpartyRef: false,
      hasRecipientRef: false,
    });
    expect(o).toBe(PAYOUT_DESTINATION_OUTCOME.DESTINATION_SAVED_VERIFICATION_FAILED);
    expect(isClientSuccessOutcome(o)).toBe(false);
  });

  it('duplicate classification stays fail-closed (no fabricated verify)', () => {
    const c = classifyCounterpartyCreateFailure({
      http_status: 409,
      mentions_duplicate: true,
    });
    expect(c).toBe(PROVIDER_LINK_FAILURE_CLASS.DUPLICATE_COUNTERPARTY_RECONCILIATION_REQUIRED);
  });

  it('mixed-version: old 200+FAILED rejected; new 422 rejected', () => {
    expect(
      interpretCompat({
        httpOk: true,
        httpStatus: 200,
        payload: { success: true, provider_auto_linked: false, provider_link_status: 'FAILED' },
      }).ok,
    ).toBe(false);
    expect(
      interpretCompat({
        httpOk: false,
        httpStatus: 422,
        payload: { success: false, outcome: 'DESTINATION_SAVED_VERIFICATION_FAILED' },
      }).ok,
    ).toBe(false);
  });

  it('handler uses linkage_version concurrency and never writes payouts_enabled', () => {
    expect(handler).toMatch(/linkage_version/);
    expect(handler).toMatch(/expectedLinkageVersion/);
    expect(handler).toMatch(/STALE_FAILURE_NOT_APPLIED|CONCURRENT_LINK_UPDATE/);
    expect(handler).toMatch(/outcomeFromLinkResult/);
    expect(handler).not.toMatch(/\.from\(["']drivers["']\)[\s\S]{0,200}payouts_enabled/);
    expect(handler).not.toMatch(/payout_operational_paused\s*:/);
    expect(handler).not.toMatch(/DESTINATION_STATUS\.MANUAL_VERIFIED/);
  });

  it('handler source has no raw bank secrets in log strings', () => {
    expect(handler).not.toMatch(/console\.(?:error|warn|log)\([^)]*(?:sort_code|account_number|iban|destination_identifier)/i);
    expect(handler).toMatch(/Normalized logs only/);
  });
});
