/**
 * Lock: Phase 3 Batch 3D1 critical money/state RPC EXECUTE lock.
 * If this fails, fix the migration — never delete or soften the lock.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.join(__dirname, '../../..');
const CANONICAL =
  'supabase/migrations/20261107211000_phase3_batch3d1_critical_money_rpc_execute_lock.sql';
const ROLLBACK =
  'supabase/migrations/rollback/rollback_20261107211000_phase3_batch3d1_critical_money_rpc_execute_lock.sql';

const REVOKED = [
  'apply_trip_modification_to_trip(uuid, text, integer, integer, integer, integer, jsonb, jsonb, jsonb)',
  'apply_approved_trip_change_from_request(trip_change_requests)',
  'advance_trip_change_after_payment(uuid)',
  'convert_driver_commission_wallet_on_trip_complete(uuid, uuid, integer, integer, integer)',
  'invoke_release_terminal_trip_hold(uuid, text)',
  'insert_payment_release_evidence_backfill(text, uuid, uuid, text, text, text, integer, integer, integer, integer, text, text, text, text, text, timestamp with time zone, jsonb, boolean)',
  'claim_company_transfer_submission(uuid, text, uuid, boolean)',
  'finalize_company_transfer_completion(uuid, text, text, timestamp with time zone, jsonb)',
  'finalize_company_transfer_submission(uuid, uuid, text, text, text, timestamp with time zone, text, text, jsonb, boolean)',
  'sync_company_transfer_provider_status(uuid, text, text, timestamp with time zone, jsonb)',
  'release_company_funding_hold(uuid, text)',
  'allocate_company_transfer_payment_reference(text, timestamp with time zone)',
  'start_stop_waiting(uuid, uuid, uuid, integer, integer, integer)',
  'stop_stop_waiting(uuid)',
  'tick_stop_waiting(uuid)',
  'ops_repair_missing_commission(uuid)',
  'snapshot_accepted_wave_commission(uuid, uuid)',
  'snapshot_driver_tier_commission_on_trip(uuid, uuid)',
  'consume_personal_voucher(uuid, uuid)',
  'driver_send_preset_offer(uuid, integer, integer[], integer)',
  'ops_replay_webhook(uuid)',
  'sync_payout_item_ledger_debit(uuid)',
  'release_sub_minimum_weekly_payout_reservations(uuid)',
];

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('phase3Batch3d1CriticalMoneyRpcExecuteLock', () => {
  it('revokes only the 23 proven service_role/postgres money signatures', () => {
    const sql = read(CANONICAL);
    expect(REVOKED).toHaveLength(23);
    expect(sql).toMatch(/NOT APPLIED/i);
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION/i);
    expect(sql).not.toMatch(/record_cash_trip_completion/);
    expect(sql).not.toMatch(/generate_invoice_number/);
    for (const sig of REVOKED) {
      const s = `public.${sig}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${s} FROM authenticated`, 'i'));
      expect(sql).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION ${s} TO service_role`, 'i'));
      expect(sql).not.toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${s} FROM postgres`, 'i'));
    }
    expect(read(ROLLBACK)).not.toMatch(/\bREVOKE\b/i);
  });
});
