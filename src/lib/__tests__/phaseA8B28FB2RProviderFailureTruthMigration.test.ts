/**
 * A8B28F-B2R Stage 1 source-lock: provider failure truth migration is additive-only.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../../..');
const FWD = resolve(
  ROOT,
  'supabase/migrations/20261109460000_phase_a8b28f_b2r_provider_failure_truth.sql',
);
const RB = resolve(
  ROOT,
  'supabase/migrations/rollback/rollback_20261109460000_phase_a8b28f_b2r_provider_failure_truth.sql',
);
const VERIFY = resolve(
  ROOT,
  'supabase/tests/phase_a8b28f_b2r_provider_failure_truth_verify.sql',
);

describe('phase A8B28F-B2R Stage 1 provider failure truth migration', () => {
  const fwd = readFileSync(FWD, 'utf8');
  const rb = readFileSync(RB, 'utf8');
  const verify = readFileSync(VERIFY, 'utf8');

  it('adds nullable failure_class and http_status columns only', () => {
    expect(fwd).toMatch(/ADD COLUMN IF NOT EXISTS provider_link_failure_class text/);
    expect(fwd).toMatch(/ADD COLUMN IF NOT EXISTS provider_http_status integer/);
    expect(fwd).not.toMatch(/UPDATE\s+public\.driver_payout_destinations/i);
    expect(fwd).not.toMatch(/PROVIDER_VERIFIED/);
    expect(fwd).not.toMatch(/driver_wallet_ledger/);
    expect(fwd).not.toMatch(/payouts_enabled/);
  });

  it('expands audit CHECK to include blocked/synced and auto-link actions', () => {
    expect(fwd).toMatch(/provider_link_blocked/);
    expect(fwd).toMatch(/provider_link_synced/);
    expect(fwd).toMatch(/provider_auto_link_failed/);
    expect(fwd).toMatch(/provider_auto_linked/);
    expect(fwd).toMatch(/changed_by_user_id DROP NOT NULL/);
  });

  it('rollback restores prior CHECK and drops additive columns', () => {
    expect(rb).toMatch(/provider_link_blocked/);
    expect(rb).toMatch(/provider_link_synced/);
    expect(rb).not.toMatch(/provider_auto_link_failed/);
    expect(rb).toMatch(/DROP COLUMN IF EXISTS provider_http_status/);
    expect(rb).toMatch(/DROP COLUMN IF EXISTS provider_link_failure_class/);
  });

  it('verify SQL asserts MK0006 remains failed/pending without provider refs', () => {
    expect(verify).toMatch(/mk_failed_pending_active/);
    expect(verify).toMatch(/20261109460000/);
    expect(verify).toMatch(/provider_link_failure_class/);
  });
});
