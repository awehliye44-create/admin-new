/**
 * A8B28F Stage A source-lock: payout operational pause foundation.
 * Ensures migration is additive-only and omits unsafe Admin RPC / Stage C cutover.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../../..');
const FWD = resolve(
  ROOT,
  'supabase/migrations/20261109430000_phase_a8b28f_payout_operational_pause_foundation.sql',
);
const RB = resolve(
  ROOT,
  'supabase/migrations/rollback/rollback_20261109430000_phase_a8b28f_payout_operational_pause_foundation.sql',
);

describe('phase A8B28F Stage A payout operational pause foundation', () => {
  const fwd = readFileSync(FWD, 'utf8');
  const rb = readFileSync(RB, 'utf8');

  it('adds operational pause column with safe default and conservative backfill', () => {
    expect(fwd).toMatch(/ADD COLUMN IF NOT EXISTS payout_operational_paused boolean NOT NULL DEFAULT false/);
    expect(fwd).toMatch(/SET payout_operational_paused = true/);
    expect(fwd).toMatch(/PROVIDER_VERIFIED/);
    expect(fwd).toMatch(/payouts_enabled, false\) IS NOT TRUE/);
  });

  it('adds additive helpers that keep legacy payouts_enabled conjunct and reject MANUAL_VERIFIED', () => {
    expect(fwd).toMatch(/driver_has_provider_verified_payout_destination/);
    expect(fwd).toMatch(/driver_effective_payout_allowed/);
    expect(fwd).toMatch(/MANUAL_VERIFIED/);
    expect(fwd).toMatch(/v_legacy IS NOT TRUE THEN RETURN false/);
    expect(fwd).toMatch(/GRANT EXECUTE ON FUNCTION public\.driver_effective_payout_allowed\(uuid\) TO authenticated/);
    expect(fwd).toMatch(/REVOKE ALL ON FUNCTION public\.driver_effective_payout_allowed\(uuid\) FROM anon/);
  });

  it('does not cut over eligibility or mutate financial writers', () => {
    expect(fwd).not.toMatch(/CREATE OR REPLACE FUNCTION public\.driver_wallet_eligibility_balances/);
    expect(fwd).not.toMatch(/CREATE OR REPLACE FUNCTION public\.get_driver_own_wallet_summary/);
    expect(fwd).not.toMatch(/CREATE OR REPLACE FUNCTION public\.admin_set_driver/);
    expect(fwd).not.toMatch(/INTO public\.driver_wallet_ledger/);
    expect(fwd).not.toMatch(/UPDATE public\.driver_wallet_ledger/);
    expect(fwd).toMatch(/OMITTED from this Stage A apply/);
    expect(fwd).toMatch(/Deferred to Stage B redesign/);
    expect(fwd).toMatch(/NOT approved and must not be applied here/);
  });

  it('rollback drops helpers before column and forbids post-Stage-B use without prior rollback', () => {
    expect(rb).toMatch(/DROP FUNCTION IF EXISTS public\.driver_effective_payout_allowed/);
    expect(rb).toMatch(/DROP FUNCTION IF EXISTS public\.driver_has_provider_verified_payout_destination/);
    expect(rb).toMatch(/DROP COLUMN IF EXISTS payout_operational_paused/);
    expect(rb).toMatch(/Stage B or Stage C/);
    const eff = rb.indexOf('driver_effective_payout_allowed');
    const col = rb.indexOf('DROP COLUMN IF EXISTS payout_operational_paused');
    expect(eff).toBeGreaterThanOrEqual(0);
    expect(col).toBeGreaterThan(eff);
  });
});
