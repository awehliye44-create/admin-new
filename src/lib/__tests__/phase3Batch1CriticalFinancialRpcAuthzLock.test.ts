/**
 * Lock: Phase 3 Batch 1 CRITICAL financial RPC authz.
 * If this fails, fix the migration — never delete or soften the lock.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.join(__dirname, '../../..');
const CANONICAL =
  'supabase/migrations/20261107160000_phase3_batch1_critical_financial_rpc_authz_lock.sql';
const ROLLBACK =
  'supabase/migrations/rollback/rollback_20261107160000_phase3_batch1_critical_financial_rpc_authz_lock.sql';

const THIRTEEN: { name: string; args: string }[] = [
  { name: 'ops_retry_failed_payout', args: 'p_payout_id uuid' },
  { name: 'ops_retry_failed_payout_item', args: 'p_payout_item_id uuid' },
  { name: 'return_failed_payout_to_wallet', args: 'p_payout_item_id uuid' },
  { name: 'get_driver_wallet_balance', args: 'p_driver_id uuid' },
  { name: 'driver_wallet_eligibility_balances', args: 'p_driver_id uuid' },
  { name: 'claim_driver_payout_submission', args: 'uuid, text, uuid' },
  {
    name: 'finalize_driver_payout_submission',
    args: 'uuid, uuid, text, text, text, timestamp with time zone, text, text, jsonb, boolean',
  },
  { name: 'abort_driver_payout_submission_claim', args: 'uuid, uuid, text, text' },
  { name: 'reserve_driver_payout_item', args: 'uuid' },
  { name: 'release_driver_payout_reservation', args: 'uuid, uuid, text' },
  {
    name: 'finalize_driver_payout_completion',
    args: 'uuid, text, text, timestamp with time zone, jsonb',
  },
  { name: 'invoke_weekly_payout_scheduler', args: '' },
  { name: 'sweep_revolut_stale_holds', args: '' },
];

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('phase3Batch1CriticalFinancialRpcAuthzLock', () => {
  it('uses precise company-funds page permission — not any staff profile', () => {
    const sql = read(CANONICAL);
    expect(sql).toMatch(/staff_has_company_funds_read_access\('payout-ledger'\)/);
    expect(sql).toMatch(/staff_has_company_funds_read_access\('driver-wallet-ledger'\)/);
    expect(sql).toMatch(/staff_has_company_funds_read_access\('financial-reconciliation'\)/);
    expect(sql).not.toMatch(/EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+public\.staff_profiles\s+sp\s+WHERE\s+sp\.user_id\s*=\s*v_uid\s+AND\s+sp\.is_active\s*=\s*true\s*\)\s*THEN/i);
  });

  it('gates retry/return before mutation with finance payout-ledger access', () => {
    const sql = read(CANONICAL);
    for (const name of [
      'ops_retry_failed_payout',
      'ops_retry_failed_payout_item',
      'return_failed_payout_to_wallet',
    ]) {
      const idx = sql.indexOf(`FUNCTION public.${name}`);
      expect(idx).toBeGreaterThan(-1);
      const gate = sql.indexOf('assert_finance_payout_ledger_access', idx);
      const upd = sql.indexOf('UPDATE', gate);
      expect(gate).toBeGreaterThan(idx);
      expect(upd).toBeGreaterThan(gate);
    }
  });

  it('gates wallet-by-id reads with owner or company-funds pages', () => {
    const sql = read(CANONICAL);
    expect(sql).toMatch(/assert_driver_wallet_read_access\(p_driver_id\)/);
    expect(sql).toMatch(/d\.user_id\s*=\s*v_uid/);
    const elig = sql.indexOf('FUNCTION public.driver_wallet_eligibility_balances');
    const gate = sql.indexOf('assert_driver_wallet_read_access', elig);
    const live = sql.indexOf('driver_wallet_live_balance_pence', gate);
    expect(gate).toBeGreaterThan(elig);
    expect(live).toBeGreaterThan(gate);
  });

  it('revokes authenticated on Edge claim/finalize/reserve/release family', () => {
    const sql = read(CANONICAL);
    for (const name of [
      'claim_driver_payout_submission',
      'finalize_driver_payout_submission',
      'abort_driver_payout_submission_claim',
      'reserve_driver_payout_item',
      'release_driver_payout_reservation',
      'finalize_driver_payout_completion',
    ]) {
      expect(sql).toMatch(
        new RegExp(
          String.raw`REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.${name}\s*\([^)]*\)\s+FROM\s+authenticated`,
          'i',
        ),
      );
      expect(sql).toMatch(
        new RegExp(
          String.raw`GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.${name}\s*\([^)]*\)\s+TO\s+service_role`,
          'i',
        ),
      );
    }
  });

  it('revokes client and service_role from cron money triggers (postgres-only)', () => {
    const sql = read(CANONICAL);
    for (const name of ['invoke_weekly_payout_scheduler', 'sweep_revolut_stale_holds']) {
      expect(sql).toMatch(
        new RegExp(
          String.raw`REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.${name}\(\)\s+FROM\s+authenticated`,
          'i',
        ),
      );
      expect(sql).toMatch(
        new RegExp(
          String.raw`REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.${name}\(\)\s+FROM\s+service_role`,
          'i',
        ),
      );
    }
  });

  it('fixes search_path on new helpers and replaced SECDEF bodies', () => {
    const sql = read(CANONICAL);
    expect(sql).toMatch(
      /CREATE OR REPLACE FUNCTION public\.assert_finance_payout_ledger_access[\s\S]*?SET search_path TO 'public'/i,
    );
    expect(sql).toMatch(
      /CREATE OR REPLACE FUNCTION public\.assert_driver_wallet_read_access[\s\S]*?SET search_path TO 'public'/i,
    );
    expect(sql).toMatch(/SET search_path TO 'public'/g);
  });

  it('does not bulk-revoke authenticated EXECUTE or alter cron schedules', () => {
    const sql = read(CANONICAL);
    expect(sql).not.toMatch(/REVOKE\s+ALL\s+ON\s+ALL\s+FUNCTIONS/i);
    expect(sql).not.toMatch(/cron\.(schedule|unschedule)/i);
    expect(sql).not.toMatch(/ALTER\s+POLICY|ENABLE\s+ROW\s+LEVEL/i);
  });

  it('covers all 13 CRITICAL signatures explicitly', () => {
    const sql = read(CANONICAL);
    for (const fn of THIRTEEN) {
      expect(sql).toMatch(new RegExp(String.raw`\b${fn.name}\b`));
    }
    expect(THIRTEEN).toHaveLength(13);
  });

  it('rollback restores pre-Batch1 bodies and drops helpers', () => {
    const rb = read(ROLLBACK);
    expect(rb).toMatch(/CREATE OR REPLACE FUNCTION public\.ops_retry_failed_payout/);
    expect(rb).toMatch(/CREATE OR REPLACE FUNCTION public\.driver_wallet_eligibility_balances/);
    expect(rb).toMatch(/DROP FUNCTION IF EXISTS public\.assert_finance_payout_ledger_access/);
    expect(rb).toMatch(/DROP FUNCTION IF EXISTS public\.assert_driver_wallet_read_access/);
    expect(rb).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.claim_driver_payout_submission[\s\S]*TO authenticated/i,
    );
  });
});
