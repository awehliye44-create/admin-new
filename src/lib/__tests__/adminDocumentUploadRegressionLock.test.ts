/**
 * Lock: Admin upload must not redefine driver submit, compliance SSOT, or Go Online.
 * Also: Owner retains documents.admin_upload via seed + staff_has_action is_owner bypass.
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const ROOT = path.join(__dirname, '../../..');
const MIGRATION =
  'supabase/migrations/20270226120000_admin_submit_driver_document.sql';
const ROLES_PAGE = 'src/pages/RolesPermissions.tsx';
const DIALOG = 'src/components/drivers/AdminAddDriverDocumentsDialog.tsx';
const DRIVERS = 'src/pages/Drivers.tsx';

describe('adminDocumentUploadRegressionLock', () => {
  const sql = fs.readFileSync(path.join(ROOT, MIGRATION), 'utf8');
  const rolesPage = fs.readFileSync(path.join(ROOT, ROLES_PAGE), 'utf8');
  const dialog = fs.readFileSync(path.join(ROOT, DIALOG), 'utf8');
  const drivers = fs.readFileSync(path.join(ROOT, DRIVERS), 'utf8');

  it('does not redefine driver submit, compliance view, or go-online helpers', () => {
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION public\.submit_driver_document\s*\(/i);
    expect(sql).not.toMatch(/CREATE OR REPLACE VIEW public\.driver_document_compliance_ssot/i);
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION public\.driver_can_go_online/i);
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION public\.get_driver_document_compliance/i);
  });

  it('seeds documents.admin_upload for owner roles and wires Roles & Permissions UI', () => {
    expect(sql).toMatch(/WHEN c\.is_owner_role THEN true/);
    expect(rolesPage).toMatch(/DOCUMENTS_ADMIN_UPLOAD_ACTION_KEYS/);
    expect(rolesPage).toMatch(/Driver Documents — Admin Upload Capability/);
    expect(rolesPage).toMatch(/Owner retains this capability/);
  });

  it('keeps Add Documents under Edit Profile and supports multi-doc front/back + expiry', () => {
    const editIdx = drivers.indexOf('Edit Profile');
    const addIdx = drivers.indexOf('Add Documents');
    expect(editIdx).toBeGreaterThan(-1);
    expect(addIdx).toBeGreaterThan(editIdx);

    expect(dialog).toMatch(/side: 'front'/);
    expect(dialog).toMatch(/side: 'back'/);
    expect(dialog).toMatch(/has_expiry/);
    expect(dialog).toMatch(/admin_submit_driver_document/);
    expect(dialog).toMatch(/Pending Review/);
  });

  it('forces pending and blocks approved replacement without can_upload_replacement', () => {
    expect(sql).toMatch(/REPLACEMENT_NOT_ALLOWED/);
    expect(sql).toMatch(/can_upload_replacement/);
    expect(sql).toMatch(/'status',\s*'pending'/);
    expect(dialog).toMatch(/can_upload_replacement === true/);
  });
});
