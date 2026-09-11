/**
 * Lock: Phase A8B26 lost_property_admin_unread_count body authorization.
 * If this fails, fix the draft — never delete or soften the lock.
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const ROOT = path.join(__dirname, '../../..');
const CANONICAL =
  'supabase/migrations/20261109400000_phase_a8b26_lost_property_admin_unread_count_authz_lock.sql';
const ROLLBACK =
  'supabase/migrations/rollback/rollback_20261109400000_phase_a8b26_lost_property_admin_unread_count_authz_lock.sql';
const VERIFY = 'supabase/tests/phase_a8b26_lost_property_admin_unread_count_authz_verify.sql';
const EDGE = 'supabase/functions/lost-property/index.ts';
const HELPERS = 'supabase/functions/_shared/lostPropertyHelpers.ts';
const HOOK = 'src/hooks/useLostProperty.ts';
const SIDEBAR = 'src/components/layout/AdminSidebar.tsx';

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('phaseA8B26LostPropertyAdminUnreadCountAuthzLock', () => {
  it('gates lost-property page access, retains service_role, restores baseline', () => {
    const sql = read(CANONICAL);
    const rb = read(ROLLBACK);
    const verify = read(VERIFY);

    expect(sql).toMatch(/Applied to ACTIVE_HEALTHY/i);
    expect(sql).toMatch(/db6f1af9a933be79c723379c98d2eb35/);
    expect(sql).toMatch(/9fd0d843f5bc03ab2051565fd5f94922/);
    expect(sql).toMatch(/staff_has_page_access\('lost-property'\)/);
    expect(sql).toMatch(/auth\.role\(\) IS DISTINCT FROM 'service_role'/);
    expect(sql).toMatch(/RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501'/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.lost_property_admin_unread_count\(\) TO authenticated/i);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.lost_property_admin_unread_count\(\) TO service_role/i);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.lost_property_admin_unread_count\(\) FROM (PUBLIC|anon)/i);
    expect(sql).not.toMatch(/current_user\s*=\s*'postgres'/);
    expect(sql).not.toMatch(/profiles\.role/);
    expect(sql).not.toMatch(/user_metadata|raw_user_meta_data|app_metadata/);
    expect(sql).not.toMatch(/REVOKE ALL ON FUNCTION public\.lost_property_admin_unread_count\(\) FROM (authenticated|service_role)/i);

    expect(rb).toMatch(/LANGUAGE sql/);
    expect(rb).toMatch(/db6f1af9a933be79c723379c98d2eb35/);
    expect(rb).toMatch(/GRANT EXECUTE ON FUNCTION public\.lost_property_admin_unread_count\(\) TO authenticated/i);
    expect(rb).toMatch(/GRANT EXECUTE ON FUNCTION public\.lost_property_admin_unread_count\(\) TO service_role/i);
    expect(rb).not.toMatch(/staff_has_page_access/);
    expect(rb).not.toMatch(/GRANT EXECUTE.*TO (PUBLIC|anon)/i);

    expect(verify).toMatch(/A8B26_SIM_OK/);
    expect(verify).toMatch(/BEGIN;/);
    expect(verify).toMatch(/ROLLBACK;/);
  });

  it('proves Admin browser RPC and Edge requireAdmin-before-rpc gates', () => {
    const hook = read(HOOK);
    const sidebar = read(SIDEBAR);
    const edge = read(EDGE);
    const helpers = read(HELPERS);

    expect(hook).toMatch(/supabase\.rpc\('lost_property_admin_unread_count'\)/);
    expect(sidebar).toMatch(/useLostPropertyUnreadCount/);
    expect(sidebar).toMatch(/pageSlug="lost-property"/);

    expect(edge).toMatch(/case "admin_unread_count": return await adminUnreadCount\(req\)/);
    expect(edge).toMatch(/const admin = await requireAdmin\(req\)/);
    expect(edge).toMatch(/if \(admin instanceof Response\) return admin/);
    expect(edge).toMatch(/getServiceClient\(\)/);
    expect(edge).toMatch(/\.rpc\("lost_property_admin_unread_count"\)/);

    // requireAdmin must authenticate Authorization Bearer before service RPC
    expect(helpers).toMatch(/export async function requireAdmin/);
    expect(helpers).toMatch(/authenticateCaller\(req\)/);
    expect(helpers).toMatch(/Authorization/);
    expect(helpers).toMatch(/getServiceClient\(\)/);
    // Lock documents incomplete profiles.role gate; must not be copied into SQL remediation
    expect(helpers).toMatch(/profiles[\s\S]*role[\s\S]*admin/);
    expect(read(CANONICAL)).not.toMatch(/profiles\.role/);
  });
});
