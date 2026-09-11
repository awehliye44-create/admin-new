/**
 * A8B28F Stage C source-lock (canonical migration paths).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../../..');
const DRAFT = resolve(
  ROOT,
  'supabase/migrations/20261109470000_phase_a8b28f_stage_c_wallet_payout_eligibility_cutover.sql',
);
const RB = resolve(
  ROOT,
  'supabase/migrations/rollback/rollback_20261109470000_phase_a8b28f_stage_c_wallet_payout_eligibility_cutover.sql',
);
const VERIFY = resolve(
  ROOT,
  'supabase/tests/phase_a8b28f_stage_c_wallet_payout_eligibility_cutover_verify.sql',
);
const PLACEHOLDER = resolve(
  ROOT,
  'supabase/drafts/A8B28F_payout_destination_provider_verification_repair/stageC/20261109440000_phase_a8b28f_stage_c_eligibility_cutover.sql',
);

describe('phase A8B28F Stage C wallet payout eligibility cutover (canonical)', () => {
  const fwd = readFileSync(DRAFT, 'utf8');
  const rb = readFileSync(RB, 'utf8');
  const verify = readFileSync(VERIFY, 'utf8');
  const placeholder = readFileSync(PLACEHOLDER, 'utf8');

  it('is apply-approved and names the cutover timestamp', () => {
    expect(fwd).toMatch(/APPLY-APPROVED/);
    expect(fwd).toMatch(/20261109470000_phase_a8b28f_stage_c_wallet_payout_eligibility_cutover/);
    expect(fwd).toMatch(/Canonical apply path|Stage C wallet payout eligibility cutover/);
    expect(placeholder).toMatch(/SUPERSEDED_BY_20261109470000|20261109440000/);
  });

  it('replaces eligibility legacy short-circuit with operational pause only', () => {
    expect(fwd).toMatch(/CREATE OR REPLACE FUNCTION public\.driver_wallet_eligibility_balances/);
    expect(fwd).toMatch(/v_operational_paused boolean := false/);
    expect(fwd).toMatch(/SELECT COALESCE\(payout_operational_paused, false\)/);
    expect(fwd).toMatch(/IF v_operational_paused IS TRUE THEN/);
    expect(fwd).not.toMatch(/v_payouts_enabled/);
    expect(fwd).toMatch(/DRIVER_COLLECTED/);
    expect(fwd).toMatch(/driver_wallet_payout_clearing_delay_hours/);
  });

  it('drops legacy conjunct from driver_effective_payout_allowed but keeps global/OP/provider/approval', () => {
    expect(fwd).toMatch(/CREATE OR REPLACE FUNCTION public\.driver_effective_payout_allowed/);
    expect(fwd).not.toMatch(/v_legacy/);
    expect(fwd).toMatch(/setting_key = 'payouts_enabled'/);
    expect(fwd).toMatch(/payout_operational_paused/);
    expect(fwd).toMatch(/driver_has_provider_verified_payout_destination/);
    expect(fwd).toMatch(/IF v_paused THEN RETURN false/);
    expect(fwd).toMatch(/IF NOT v_provider THEN RETURN false/);
  });

  it('rewrites summary early blocks away from legacy DRIVER_SUSPENDED mislabel', () => {
    expect(fwd).toMatch(/CREATE OR REPLACE FUNCTION public\.driver_wallet_summary_ssot/);
    expect(fwd).not.toMatch(/v_driver\.payouts_enabled/);
    expect(fwd).toMatch(/ADMIN_HOLD/);
    expect(fwd).toMatch(/DRIVER_NOT_APPROVED/);
    expect(fwd).toMatch(/PAYOUT_ACCOUNT_NOT_VERIFIED/);
    expect(fwd).toMatch(/v5_a8b28f_stage_c/);
  });

  it('routes reserve hold gate through effective helper', () => {
    expect(fwd).toMatch(/CREATE OR REPLACE FUNCTION public\.reserve_driver_payout_item/);
    expect(fwd).toMatch(/driver_effective_payout_allowed\(v_item\.driver_id\)/);
    expect(fwd).not.toMatch(/v_driver\.payouts_enabled/);
  });

  it('does not flip payout flags or invent ledger settlement writers in eligibility/summary/effective', () => {
    expect(fwd).not.toMatch(/UPDATE\s+public\.drivers/i);
    expect(fwd).not.toMatch(/payouts_enabled\s*=/);
    expect(fwd).not.toMatch(/payout_operational_paused\s*=/);
    // eligibility + effective + summary must not insert ledger rows
    const eligStart = fwd.indexOf('CREATE OR REPLACE FUNCTION public.driver_wallet_eligibility_balances');
    const sumStart = fwd.indexOf('CREATE OR REPLACE FUNCTION public.driver_wallet_summary_ssot');
    const resStart = fwd.indexOf('CREATE OR REPLACE FUNCTION public.reserve_driver_payout_item');
    const eligChunk = fwd.slice(eligStart, sumStart);
    const sumChunk = fwd.slice(sumStart, resStart);
    expect(eligChunk).not.toMatch(/INSERT INTO public\.driver_wallet_ledger/);
    expect(sumChunk).not.toMatch(/INSERT INTO public\.driver_wallet_ledger/);
  });

  it('ships rollback + verify that restore legacy gate and assert MK0006 matrix', () => {
    expect(rb).toMatch(/v_payouts_enabled|v_legacy/);
    expect(rb).toMatch(/v_driver\.payouts_enabled|COALESCE\(v_driver\.payouts_enabled/);
    expect(verify).toMatch(/MK0006/);
    expect(verify).toMatch(/available expected 425/);
    expect(verify).toMatch(/pending expected 0/);
    expect(verify).toMatch(/effective_payout_allowed expected true/);
  });
});
