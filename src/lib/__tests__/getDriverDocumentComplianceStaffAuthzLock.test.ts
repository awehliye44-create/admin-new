/**
 * Lock: get_driver_document_compliance must not cast invalid app_role labels.
 * app_role is (admin, moderator, user, driver, customer). Calling has_role(..., 'staff')
 * or has_role(..., 'super_admin') crashes Admin "Add driver documents" for staff sessions.
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const ROOT = path.join(__dirname, '../../..');
const MIGRATION =
  'supabase/migrations/20270226130000_fix_get_driver_document_compliance_staff_authz.sql';

describe('getDriverDocumentComplianceStaffAuthzLock', () => {
  const sql = fs.readFileSync(path.join(ROOT, MIGRATION), 'utf8');

  it('replaces the RPC without inventing staff/super_admin app_role values', () => {
    expect(sql).toMatch(
      /CREATE OR REPLACE FUNCTION public\.get_driver_document_compliance\s*\(/i,
    );
    expect(sql).not.toMatch(/has_role\([^)]*['"]staff['"]/i);
    expect(sql).not.toMatch(/has_role\([^)]*['"]super_admin['"]/i);
    expect(sql).toMatch(/is_super_admin\s*\(/);
    expect(sql).toMatch(/staff_profiles/);
    expect(sql).toMatch(/has_role\([^)]*'admin'::public\.app_role/);
  });
});
