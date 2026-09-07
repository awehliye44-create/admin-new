/**
 * Lock: Phase 3 Batch 3D2 cross-account financial read EXECUTE lock.
 * If this fails, fix the migration — never delete or soften the lock.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.join(__dirname, '../../..');
const CANONICAL =
  'supabase/migrations/20261107212000_phase3_batch3d2_cross_account_financial_read_lock.sql';
const ROLLBACK =
  'supabase/migrations/rollback/rollback_20261107212000_phase3_batch3d2_cross_account_financial_read_lock.sql';

const REVOKED = [
  'get_driver_ledger_aggregates(uuid)',
  'driver_wallet_live_balance_pence(uuid)',
  'driver_wallet_available_for_payout_pence(uuid)',
  'driver_wallet_active_reservation_pence(uuid)',
  'driver_wallet_other_holds_pence(uuid)',
  'driver_wallet_ledger_economic_fields(uuid)',
  'driver_commission_wallet_balance_parts(uuid, uuid)',
  'driver_commission_wallet_usable_balance_minor(uuid, uuid)',
  'get_customer_lifecycle_debt_pence(uuid)',
  'payment_gate_historical_audit()',
  'audit_payment_session_amounts(uuid)',
  'payment_session_action_policy(uuid, jsonb)',
  'assert_payment_gate(uuid)',
  'assert_payment_authorized(uuid)',
  'payment_authorisation_valid(uuid)',
  'compute_driver_net_preview_from_gross(integer, uuid, uuid, integer)',
  'ops_reconciliation_diagnostics()',
  'driver_passes_commission_wallet_dispatch_gate(uuid, uuid)',
  'ride_offer_build_send_notification_body(uuid)',
];

const KEPT = [
  'get_driver_own_wallet_summary',
  'get_driver_own_wallet_earning_rows',
  'get_driver_wallet_balance',
  'driver_wallet_eligibility_balances',
  'admin_driver_financial_summaries',
  'admin_driver_wallet_eligibility_balances',
];

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('phase3Batch3d2CrossAccountFinancialReadLock', () => {
  it('revokes ungated readers and wrappers only', () => {
    const sql = read(CANONICAL);
    expect(REVOKED).toHaveLength(19);
    expect(sql).toMatch(/NOT APPLIED/i);
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION/i);
    for (const name of KEPT) {
      expect(sql).not.toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${name}`));
    }
    for (const sig of REVOKED) {
      const s = `public.${sig}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${s} FROM authenticated`, 'i'));
      expect(sql).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION ${s} TO service_role`, 'i'));
    }
    expect(read(ROLLBACK)).not.toMatch(/\bREVOKE\b/i);
  });
});
