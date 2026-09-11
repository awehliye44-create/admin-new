/**
 * A8B28F Stage B1 source-lock: admin_set_driver_payout_operational_pause.
 * Canonical migration paths only. service_role EXECUTE must be denied.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../../..');
const FWD = resolve(
  ROOT,
  'supabase/migrations/20261109450000_phase_a8b28f_admin_payout_operational_pause_rpc.sql',
);
const RB = resolve(
  ROOT,
  'supabase/migrations/rollback/rollback_20261109450000_phase_a8b28f_admin_payout_operational_pause_rpc.sql',
);
const CLEARING = resolve(
  ROOT,
  'supabase/migrations/20260926120000_driver_wallet_payout_clearing_gate.sql',
);
const ELIG = resolve(
  ROOT,
  'supabase/migrations/20260926124000_driver_wallet_available_cap_unpaid_live.sql',
);
const ADMIN_CLIENT = resolve(ROOT, 'src/integrations/supabase/client.ts');
const B5_DRAFT = resolve(
  ROOT,
  'supabase/drafts/A8B28F_stage_b/B5/adminSetDriverPayoutOperationalPause.ts',
);

describe('phase A8B28F Stage B1 admin_set_driver_payout_operational_pause', () => {
  const fwd = readFileSync(FWD, 'utf8');
  const rb = readFileSync(RB, 'utf8');
  const clearing = readFileSync(CLEARING, 'utf8');
  const elig = readFileSync(ELIG, 'utf8');
  const adminClient = readFileSync(ADMIN_CLIENT, 'utf8');
  const b5 = readFileSync(B5_DRAFT, 'utf8');

  it('defines SECURITY DEFINER VOLATILE RPC with finance ACL and authenticated-only EXECUTE', () => {
    expect(fwd).toMatch(/CREATE OR REPLACE FUNCTION public\.admin_set_driver_payout_operational_pause\(/);
    expect(fwd).toMatch(/p_driver_id uuid/);
    expect(fwd).toMatch(/p_paused boolean/);
    expect(fwd).toMatch(/p_reason text/);
    expect(fwd).toMatch(/SECURITY DEFINER/);
    expect(fwd).toMatch(/\bVOLATILE\b/);
    expect(fwd).toMatch(/SET search_path TO 'public'/);
    expect(fwd).toMatch(/PERFORM public\.assert_finance_payout_ledger_access\(\)/);
    expect(fwd).toMatch(/v_actor uuid := auth\.uid\(\)/);
    expect(fwd).toMatch(/ERRCODE = '42501'/);
    expect(fwd).toMatch(/OWNER TO postgres/);
    expect(fwd).toMatch(/REVOKE ALL ON FUNCTION public\.admin_set_driver_payout_operational_pause\(uuid, boolean, text\) FROM PUBLIC/);
    expect(fwd).toMatch(/REVOKE ALL ON FUNCTION public\.admin_set_driver_payout_operational_pause\(uuid, boolean, text\) FROM anon/);
    expect(fwd).toMatch(/REVOKE ALL ON FUNCTION public\.admin_set_driver_payout_operational_pause\(uuid, boolean, text\) FROM service_role/);
    expect(fwd).toMatch(/GRANT EXECUTE ON FUNCTION public\.admin_set_driver_payout_operational_pause\(uuid, boolean, text\) TO authenticated/);
    expect(fwd).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.admin_set_driver_payout_operational_pause\(uuid, boolean, text\) TO service_role/);
    expect(fwd).not.toMatch(/profiles\.role/);
    expect(fwd).not.toMatch(/user_metadata/);
    expect(fwd).not.toMatch(/raw_user_meta_data/);
  });

  it('proves future Admin caller is publishable client + authenticated JWT (no service_role Edge)', () => {
    expect(adminClient).toMatch(/VITE_SUPABASE_PUBLISHABLE_KEY/);
    expect(adminClient).toMatch(/createClient/);
    expect(b5).toMatch(/supabase\.rpc\("admin_set_driver_payout_operational_pause"/);
    expect(b5).not.toMatch(/SERVICE_ROLE/);
    expect(b5).not.toMatch(/service_role/);
  });

  it('dual-writes pause + legacy payouts_enabled; audits only on change; actor/reason/before/after', () => {
    expect(fwd).toMatch(/payout_operational_paused = p_paused/);
    expect(fwd).toMatch(/payouts_enabled = v_after_legacy/);
    expect(fwd).toMatch(/v_after_legacy := NOT p_paused/);
    expect(fwd).toMatch(/FOR UPDATE/);
    expect(fwd).toMatch(/IF NOT v_unchanged THEN/);
    expect(fwd).toMatch(/INSERT INTO public\.payout_audit_log/);
    expect(fwd).toMatch(/actor_user_id/);
    expect(fwd).toMatch(/DRIVER_PAYOUT_OPERATIONAL_PAUSE/);
    expect(fwd).toMatch(/destination_mutated',\s*false/);
  });

  it('does not mutate destinations, wallet ledger, or Stage C eligibility', () => {
    expect(fwd).not.toMatch(/UPDATE public\.driver_payout_destinations/);
    expect(fwd).not.toMatch(/MANUAL_VERIFIED/);
    expect(fwd).not.toMatch(/SET\s+verification_status/);
    expect(fwd).not.toMatch(/driver_wallet_ledger/);
    expect(fwd).not.toMatch(/CREATE OR REPLACE FUNCTION public\.driver_wallet_eligibility_balances/);
    expect(fwd).toMatch(/20261109440000 remains unused/);
    expect(fwd).not.toMatch(/phase_a8b28f_stage_c_eligibility_cutover/);
  });

  it('rollback drops only the RPC', () => {
    expect(rb).toMatch(/DROP FUNCTION IF EXISTS public\.admin_set_driver_payout_operational_pause\(uuid, boolean, text\)/);
    expect(rb).not.toMatch(/DROP COLUMN IF EXISTS payout_operational_paused/);
  });

  it('proves inverse dual-write cannot skip provider verification on withdraw path', () => {
    expect(clearing).toMatch(/PAYOUT_ACCOUNT_NOT_VERIFIED/);
    expect(clearing).toMatch(/PROVIDER_VERIFIED/);
    const enabledIdx = clearing.indexOf('payouts_enabled');
    const destIdx = clearing.indexOf('PROVIDER_VERIFIED');
    const blockIdx = clearing.indexOf('PAYOUT_ACCOUNT_NOT_VERIFIED');
    expect(enabledIdx).toBeGreaterThan(0);
    expect(destIdx).toBeGreaterThan(enabledIdx);
    expect(blockIdx).toBeGreaterThan(destIdx);
    expect(elig).toMatch(/payouts_enabled/);
  });
});
