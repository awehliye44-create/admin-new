/**
 * Lock: Phase A8B27B lost-property cron internal auth bridge + Edge gate.
 * If this fails, fix the migration/draft — never delete or soften the lock.
 * SQL Stage 1 is applied; Edge gate section remains draft until Stage 2 deploy.
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const ROOT = path.join(__dirname, '../../..');
const MIG =
  'supabase/migrations/20261109410000_phase_a8b27b_lost_property_cron_internal_auth_bridge.sql';
const RB =
  'supabase/migrations/rollback/rollback_20261109410000_phase_a8b27b_lost_property_cron_internal_auth_bridge.sql';
const VERIFY = 'supabase/tests/phase_a8b27b_lost_property_cron_internal_auth_verify.sql';
const EDGE_AUTH = 'supabase/functions/_shared/lostPropertyCronAuth.ts';
const ENTRY = 'supabase/functions/lost-property/index.ts';
const HELPERS = 'supabase/functions/_shared/lostPropertyHelpers.ts';

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('phaseA8B27BLostPropertyCronInternalAuth', () => {
  it('drafts postgres-only Vault header helper and rewrites cron without Bearer literals', () => {
    const sql = read(MIG);
    const rb = read(RB);
    const verify = read(VERIFY);

    expect(sql).toMatch(/Applied to ACTIVE_HEALTHY/i);
    expect(sql).toMatch(/onecab_internal_lost_property_cron_token/);
    expect(sql).toMatch(/onecab_internal_lost_property_cron_http_headers/);
    expect(sql).toMatch(/X-ONECAB-INTERNAL-LOST-PROPERTY-CRON-TOKEN/);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.onecab_internal_lost_property_cron_http_headers\(\) FROM service_role/i);
    expect(sql).toMatch(/cron\.alter_job/);
    expect(sql).toMatch(/action=cleanup_photos/);
    expect(sql).toMatch(/action=expire_chats/);
    expect(sql).not.toMatch(/eyJhbGciOi/);
    expect(sql).not.toMatch(/Bearer eyJ/);
    expect(sql).not.toMatch(/CREATE SECRET|vault\.create_secret/i);

    expect(rb).toMatch(/DROP FUNCTION IF EXISTS public\.onecab_internal_lost_property_cron_http_headers/);
    expect(rb).not.toMatch(/eyJhbGciOi/);
    expect(verify).toMatch(/A8B27B_SIM_OK/);
    expect(verify).toMatch(/ROLLBACK;/);
    expect(verify).not.toMatch(/PERFORM net\.http_post/);
  });

  it('Edge gate admits only dedicated header for cron actions and preserves A8B27 Admin gate', () => {
    const auth = read(EDGE_AUTH);
    const entry = read(ENTRY);
    const helpers = read(HELPERS);

    expect(auth).toMatch(/authorizeLostPropertyCronRequest/);
    expect(auth).toMatch(/ONECAB_INTERNAL_LOST_PROPERTY_CRON_TOKEN/);
    expect(auth).toMatch(/timingSafeEqualString/);
    expect(auth).toMatch(/cleanup_photos/);
    expect(auth).toMatch(/expire_chats/);
    expect(auth).not.toMatch(/eyJ/);
    expect(auth).not.toMatch(/profiles\.role/);

    expect(entry).toMatch(/isLostPropertyCronAction\(action\)/);
    expect(entry).toMatch(/authorizeLostPropertyCronRequest\(req\)/);
    expect(entry).toMatch(/requireAdmin\(req\)/);
    expect(entry).toMatch(/authenticateCaller\(req\)/);

    // A8B27 Admin page gate remains
    expect(helpers).toMatch(/staffHasPageAccessForUser/);
    expect(helpers).toMatch(/LOST_PROPERTY_PAGE_SLUG = "lost-property"/);
    expect(helpers).not.toMatch(/from\("profiles"\)/);
  });
});
