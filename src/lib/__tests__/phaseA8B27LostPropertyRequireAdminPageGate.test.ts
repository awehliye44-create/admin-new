/**
 * Lock: Phase A8B27 lost-property Edge requireAdmin uses staff page access.
 * If this fails, fix the draft — never delete or soften the lock.
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const ROOT = path.join(__dirname, '../../..');
const HELPERS = 'supabase/functions/_shared/lostPropertyHelpers.ts';
const ENTRY = 'supabase/functions/lost-property/index.ts';
const DENO_TEST = 'supabase/functions/_shared/lostPropertyHelpers.a8b27.test.ts';

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('phaseA8B27LostPropertyRequireAdminPageGate', () => {
  it('replaces profiles.role with lost-property staff page access after JWT verify', () => {
    const helpers = read(HELPERS);
    const entry = read(ENTRY);
    const denoTest = read(DENO_TEST);

    expect(helpers).toMatch(/Phase A8B27/);
    expect(helpers).toMatch(/version: 266/);
    expect(helpers).toMatch(/ezbr_sha256: 2b9d3652fb9dcd240eaf68cb7eb23edb5839d7ef8f7e67cc95e0ade23c58d730/);
    expect(helpers).toMatch(/LOST_PROPERTY_PAGE_SLUG = "lost-property"/);
    expect(helpers).toMatch(/staffHasPageAccessForUser/);
    expect(helpers).toMatch(/evaluateStaffHasPageAccess/);
    expect(helpers).toMatch(/authenticateCaller\(req\)/);
    expect(helpers).toMatch(/getClaims\(token\)/);
    expect(helpers).toMatch(/\.from\("staff_profiles"\)/);
    expect(helpers).toMatch(/\.from\("role_page_permissions"\)/);
    expect(helpers).toMatch(/page_slug/);
    expect(helpers).toMatch(/is_active/);
    expect(helpers).toMatch(/Forbidden: admin only/);

    expect(helpers).not.toMatch(/from\("profiles"\)/);
    expect(helpers).not.toMatch(/profiles\.role|data\.role !== ["']admin["']/);
    expect(helpers).not.toMatch(/user_metadata|raw_user_meta_data|app_metadata/);
    expect(helpers).not.toMatch(/current_user/);
    expect(helpers).not.toMatch(/\.rpc\(\s*['"]staff_has_page_access['"]/);

    // Admin actions still use requireAdmin; driver/customer keep authenticateCaller
    expect(entry).toMatch(/requireAdmin\(req\)/);
    expect(entry).toMatch(/authenticateCaller\(req\)/);
    expect(entry).toMatch(/case "admin_unread_count"/);
    expect(entry).toMatch(/case "cleanup_photos"/);
    expect(entry).toMatch(/case "expire_chats"/);
    expect(entry).toMatch(/case "create_case"/);
    expect(entry).toMatch(/case "driver_mark_found"/);

    expect(denoTest).toMatch(/inactive staff denied/);
    expect(denoTest).toMatch(/without page denied/);
    expect(denoTest).toMatch(/missing Authorization/);
  });

  it('keeps requireAdmin scoped to lostPropertyHelpers (not adminPaymentGate)', () => {
    const helpers = read(HELPERS);
    expect(helpers).toMatch(/export async function requireAdmin/);
    // Shared helper must not import payment gate
    expect(helpers).not.toMatch(/adminPaymentGate/);
  });
});
