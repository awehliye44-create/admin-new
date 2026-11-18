/**
 * Lock: admin_submit_driver_document migration enforces authz, eligibility,
 * storage ownership, pending-only status, and approved-replacement SSOT.
 * Side SSOT correction lives in the follow-up migration (do not edit applied SQL).
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const ROOT = path.join(__dirname, '../../..');
const MIGRATION =
  'supabase/migrations/20270226120000_admin_submit_driver_document.sql';
const SIDE_FIX =
  'supabase/migrations/20270226140000_admin_submit_driver_document_side_ssot.sql';

describe('adminSubmitDriverDocumentLock', () => {
  const sql = fs.readFileSync(path.join(ROOT, MIGRATION), 'utf8');
  const sideFix = fs.readFileSync(path.join(ROOT, SIDE_FIX), 'utf8');

  it('seeds documents.admin_upload and does not redefine driver submit', () => {
    expect(sql).toMatch(/documents\.admin_upload/);
    expect(sql).toMatch(/INSERT INTO public\.role_action_permissions/);
    expect(sql).not.toMatch(
      /CREATE OR REPLACE FUNCTION public\.submit_driver_document\s*\(/i,
    );
    expect(sql).toMatch(
      /CREATE OR REPLACE FUNCTION public\.admin_submit_driver_document\s*\(/i,
    );
    expect(sideFix).not.toMatch(
      /CREATE OR REPLACE FUNCTION public\.submit_driver_document\s*\(/i,
    );
  });

  it('requires staff action + registration verification server-side', () => {
    expect(sql).toMatch(
      /staff_has_action\(\s*v_uid\s*,\s*'documents\.admin_upload'\s*\)/,
    );
    expect(sql).toMatch(
      /driver_has_completed_registration_verification\(\s*p_driver_id\s*\)/,
    );
    expect(sql).toMatch(/email_verified IS TRUE/);
    expect(sql).toMatch(/phone_verified IS TRUE/);
    expect(sql).toMatch(/terms_accepted_at IS NOT NULL/);
    expect(sql).toMatch(/nullif\(trim\(d\.terms_version\),\s*''\) IS NOT NULL/);
    expect(sql).toMatch(/DRIVER_NOT_ELIGIBLE/);
    expect(sql).toMatch(/FORBIDDEN/);
    expect(sideFix).toMatch(
      /staff_has_action\(\s*v_uid\s*,\s*'documents\.admin_upload'\s*\)/,
    );
    expect(sideFix).toMatch(/REPLACEMENT_NOT_ALLOWED/);
    expect(sideFix).toMatch(/STORAGE_OWNERSHIP/);
  });

  it('blocks silent overwrite of valid approved docs via can_upload_replacement', () => {
    expect(sql).toMatch(/can_upload_replacement/);
    expect(sql).toMatch(/REPLACEMENT_NOT_ALLOWED/);
    expect(sql).toMatch(/driver_document_compliance_ssot/);
    expect(sql).toMatch(/approved_valid/);
  });

  it('forces pending review and records admin audit fields without backfilling history', () => {
    expect(sql).toMatch(/status\s*=\s*'pending'/);
    expect(sql).toMatch(/upload_source\s*=\s*'admin'/);
    expect(sql).toMatch(/admin_staff_id/);
    expect(sql).toMatch(/uploaded_by/);
    expect(sql).toMatch(/uploaded_at/);
    expect(sql).toMatch(/never invent/i);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS upload_source/);
  });

  it('validates storage ownership; follow-up aligns sides with Driver SSOT', () => {
    expect(sql).toMatch(/STORAGE_OWNERSHIP/);
    expect(sql).toMatch(/split_part\(v_path,\s*'\/',\s*1\)/);
    expect(sql).toMatch(/bucket_id = 'driver-documents'/);

    expect(sideFix).toMatch(/IF v_side = 'single' THEN/);
    expect(sideFix).toMatch(/v_side := 'full'/);
    expect(sideFix).toMatch(
      /NOT IN \('front',\s*'back',\s*'full',\s*'other'\)/,
    );
    expect(sideFix).not.toMatch(
      /NOT IN \('front',\s*'back',\s*'single'\)/,
    );
    // Must not widen or drop the table CHECK (comment may name it).
    expect(sideFix).not.toMatch(
      /ALTER\s+TABLE\s+public\.document_attachments/i,
    );
    expect(sideFix).not.toMatch(
      /DROP\s+CONSTRAINT\s+.*document_attachments_side_check/i,
    );
    expect(sideFix).not.toMatch(
      /ADD\s+CONSTRAINT\s+.*document_attachments_side_check/i,
    );
  });

  it('exposes verification and audit columns on page select allowlists', () => {
    expect(sql).toMatch(/'email_verified','phone_verified','terms_accepted_at','terms_version'/);
    expect(sql).toMatch(/'upload_source','uploaded_by','admin_staff_id','uploaded_at'/);
  });
});
