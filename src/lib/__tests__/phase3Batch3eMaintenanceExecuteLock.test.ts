/**
 * Lock: Phase 3 Batch 3E maintenance EXECUTE drafts.
 * If this fails, fix the draft — never delete or soften the lock.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.join(__dirname, '../../..');

const SPLITS = [
  {
    canonical: 'supabase/migrations/20261107220000_phase3_batch3e1_cron_sweep_execute_lock.sql',
    rollback: 'supabase/migrations/rollback/rollback_20261107220000_phase3_batch3e1_cron_sweep_execute_lock.sql',
    signatures: [
      'expire_stale_drivers_guarded(integer)',
      'expire_stale_drivers(integer)',
      'ops_cleanup_old_data()',
      'ride_offer_retry_unacked_push_deliveries()',
      'recalculate_drivers_compliance_london_daily()',
    ],
  },
  {
    canonical: 'supabase/migrations/20261107221000_phase3_batch3e2_edge_maintenance_execute_lock.sql',
    rollback: 'supabase/migrations/rollback/rollback_20261107221000_phase3_batch3e2_edge_maintenance_execute_lock.sql',
    signatures: [
      'expire_stale_offers()',
      'expire_trip_when_search_exhausted(uuid)',
      'process_ride_offer_ack_timeouts()',
      'lost_property_expire_chats()',
      'lost_property_get_cases_for_photo_cleanup()',
      'expire_due_call_masking_sessions()',
      'ops_auto_resolve_stale_alerts(integer)',
      'timeout_scheduled_offer(uuid, uuid)',
    ],
  },
  {
    canonical: 'supabase/migrations/20261107222000_phase3_batch3e3_orphan_maintenance_execute_lock.sql',
    rollback: 'supabase/migrations/rollback/rollback_20261107222000_phase3_batch3e3_orphan_maintenance_execute_lock.sql',
    signatures: [
      'expire_stale_negotiations()',
      'expire_stale_negotiations_guarded()',
      'expire_stale_modification_requests()',
      'sweep_stale_searching_trips()',
      'expire_negotiation_offer(uuid)',
    ],
  },
];

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function esc(sig: string): string {
  return `public.${sig}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('phase3Batch3eMaintenanceExecuteLock', () => {
  it('3E1 keeps service_role only on the Edge-called child', () => {
    const sql = read(SPLITS[0].canonical);
    const rb = read(SPLITS[0].rollback);
    const cronOnly = [
      'expire_stale_drivers_guarded(integer)',
      'ops_cleanup_old_data()',
      'ride_offer_retry_unacked_push_deliveries()',
      'recalculate_drivers_compliance_london_daily()',
    ];
    expect(sql).toMatch(/NOT APPLIED/i);
    expect(sql).not.toMatch(/FROM postgres/i);
    for (const sig of SPLITS[0].signatures) {
      const s = esc(sig);
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${s} FROM PUBLIC`, 'i'));
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${s} FROM anon`, 'i'));
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${s} FROM authenticated`, 'i'));
      expect(rb).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION ${s} TO authenticated`, 'i'));
      expect(rb).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION ${s} TO service_role`, 'i'));
    }
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.expire_stale_drivers\(integer\) TO service_role/i);
    expect(sql).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.expire_stale_drivers_guarded/i);
    for (const sig of cronOnly) {
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${esc(sig)} FROM service_role`, 'i'));
    }
    expect(rb).not.toMatch(/\bREVOKE\b/i);
  });

  it('3E2 revokes authenticated and keeps service_role for proven Edge callers', () => {
    const later = SPLITS.slice(1, 2).filter(
      (split) => fs.existsSync(path.join(ROOT, split.canonical)),
    );
    if (later.length === 0) return;
    const seen = new Set<string>(SPLITS[0].signatures);
    for (const split of later) {
      const sql = read(split.canonical);
      const rb = read(split.rollback);
      expect(sql).toMatch(/NOT APPLIED/i);
      expect(sql).not.toMatch(/FROM postgres/i);
      expect(rb).not.toMatch(/\bREVOKE\b/i);
      for (const sig of split.signatures) {
        seen.add(sig);
        const s = esc(sig);
        expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${s} FROM authenticated`, 'i'));
        expect(sql).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION ${s} TO service_role`, 'i'));
        expect(rb).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION ${s} TO authenticated`, 'i'));
      }
    }
    expect(seen.size).toBe(13);
  });
});
