/**
 * A8B28F-B2R — provider failure truth contract (no provider I/O).
 * Canonical coverage is the Deno suite under supabase/drafts + functions/_shared.
 * This Vitest mirror uses fs/path (no node: prefix) for local package.json test runs.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';
import {
  DRIVER_FACING_VERIFY_FAILED_NEUTRAL,
  PAYOUT_DESTINATION_OUTCOME,
  PROVIDER_LINK_FAILURE_CLASS,
  classifyCounterpartyCreateFailure,
  driverFacingMessageForOutcome,
  inferCounterpartyFailureSignals,
} from '../../../supabase/functions/_shared/payoutDestinationVerificationOutcomeSSOT';
import {
  buildUkDriverRevolutCounterpartyBody,
  detectUkDriverCounterpartyKind,
} from '../../../supabase/drafts/A8B28F_B2R_provider_failure_truth/revolutUkDriverCounterpartyPayload.draft';

const ROOT = resolve(__dirname, '../../..');
const HANDLER = resolve(
  ROOT,
  'supabase/functions/_shared/updateDriverPayoutDestinationHandler.ts',
);
const SSOT = resolve(
  ROOT,
  'supabase/functions/_shared/payoutDestinationVerificationOutcomeSSOT.ts',
);

describe('phase A8B28F-B2R provider failure truth', () => {
  it('403 / IP whitelist ⇒ PROVIDER_CONFIGURATION_REQUIRED, not USER_INPUT', () => {
    const signals = inferCounterpartyFailureSignals(
      'IP address is not whitelisted. Verify IP whitelist configuration in Revolut Business Portal.',
    );
    const c = classifyCounterpartyCreateFailure({ http_status: 403, ...signals });
    expect(c).toBe(PROVIDER_LINK_FAILURE_CLASS.PROVIDER_CONFIGURATION_REQUIRED);
    expect(c).not.toBe(PROVIDER_LINK_FAILURE_CLASS.USER_INPUT_CORRECTION_REQUIRED);
  });

  it('driver/edge message for config failure is neutral (no Check the details)', () => {
    const msg = driverFacingMessageForOutcome(
      PAYOUT_DESTINATION_OUTCOME.DESTINATION_SAVED_VERIFICATION_FAILED,
      PROVIDER_LINK_FAILURE_CLASS.PROVIDER_CONFIGURATION_REQUIRED,
    );
    expect(msg).toBe(DRIVER_FACING_VERIFY_FAILED_NEUTRAL);
    expect(msg).not.toMatch(/Check the details/i);
    const ssot = readFileSync(SSOT, 'utf8');
    expect(ssot).not.toMatch(/Check the details and try again/);
  });

  it('handler persists failure truth + uses allowed audit action with actor', () => {
    const handler = readFileSync(HANDLER, 'utf8');
    expect(handler).toMatch(/provider_link_blocked/);
    expect(handler).toMatch(/changed_by_user_id: args\.actorUserId/);
    expect(handler).toMatch(/mergeFailureTruthIntoPayload/);
    expect(handler).toMatch(/provider_link_failure_class/);
    expect(handler).toMatch(/provider_http_status/);
    expect(handler).toMatch(/PROVIDER_CONFIGURATION_REQUIRED/);
    expect(handler).not.toMatch(/action:\s*"provider_auto_link_failed"/);
  });

  it('business payload builder uses company_name for ONECAB Limited', () => {
    expect(detectUkDriverCounterpartyKind('ONECAB Limited')).toBe('business');
    const body = buildUkDriverRevolutCounterpartyBody({
      accountHolderName: 'ONECAB Limited',
      destinationIdentifier: '04000379313778',
    });
    expect(body.company_name).toBe('ONECAB Limited');
    expect(body.account_no).toBe('79313778');
    expect(body.sort_code).toBe('040003');
    expect(body.bank_country).toBe('GB');
    expect(body.currency).toBe('GBP');
    expect(body).not.toHaveProperty('profile_type');
    expect(body).not.toHaveProperty('individual_name');
    expect(body).not.toHaveProperty('accounts');
  });

  it('personal holders use individual_name (draft)', () => {
    const body = buildUkDriverRevolutCounterpartyBody({
      accountHolderName: 'Jane Driver',
      sortCode: '04-00-03',
      accountNumber: '79313778',
    });
    expect(body.individual_name).toEqual({ first_name: 'Jane', last_name: 'Driver' });
    expect(body).not.toHaveProperty('company_name');
  });
});
