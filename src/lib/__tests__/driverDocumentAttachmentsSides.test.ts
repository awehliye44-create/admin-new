import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  attachmentVersionLabel,
  documentNeedsBothSides,
  dualSideApproveBlockReason,
  sideDisplayLabel,
} from '../driverDocumentAttachmentsSides';

describe('driverDocumentAttachmentsSides (admin)', () => {
  it('detects dual-side DVLA licence docs', () => {
    expect(
      documentNeedsBothSides({
        document_name: 'DVLA Driving Licence (Pink Card — Front & Back)',
        document_type: 'dvla_driving_license',
      }),
    ).toBe(true);
    expect(
      documentNeedsBothSides({
        document_name: 'MOT Certificate',
        document_type: 'mot_certificate',
      }),
    ).toBe(false);
  });

  it('blocks Approve when Front or Back is missing (unless legacy full)', () => {
    expect(dualSideApproveBlockReason([{ side: 'front' }])).toMatch(/Back/);
    expect(dualSideApproveBlockReason([{ side: 'front' }, { side: 'back' }])).toBeNull();
    expect(dualSideApproveBlockReason([{ side: 'full' }])).toBeNull();
  });

  it('labels sides and replacement state', () => {
    expect(sideDisplayLabel('front')).toBe('Front');
    expect(
      attachmentVersionLabel({
        current: {
          attachment_id: 'a2',
          side: 'front',
          created_at: '2026-07-30T12:00:00Z',
          updated_at: '2026-07-30T12:00:00Z',
        },
        history: [
          {
            attachment_id: 'a1',
            side: 'front',
            is_current: false,
            created_at: '2026-07-29T12:00:00Z',
            superseded_by: 'a2',
          },
        ],
      }),
    ).toBe('Replaced · 1 prior version');
    expect(
      attachmentVersionLabel({
        current: {
          attachment_id: 'a1',
          side: 'back',
          created_at: '2026-07-30T12:00:00Z',
          updated_at: '2026-07-30T12:00:00Z',
        },
        history: [],
      }),
    ).toBeNull();
  });
});

describe('migration contract (no Docker)', () => {
  const migrationPath = resolve(
    process.cwd(),
    'supabase/migrations/20260907120000_driver_document_attachments_sides_ssot.sql',
  );

  it('defines independent sides + same-side supersession + idempotency', () => {
    const sql = readFileSync(migrationPath, 'utf8');
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.document_attachments/);
    expect(sql).toMatch(/CHECK \(side IN \('front', 'back', 'full', 'other'\)\)/);
    expect(sql).toMatch(/uniq_document_attachments_doc_side_current/);
    expect(sql).toMatch(/uniq_document_attachments_idempotency/);
    expect(sql).toMatch(/p_side text DEFAULT 'full'/);
    expect(sql).toMatch(/AND a\.side = v_side/);
    expect(sql).toMatch(/SIDE_INVALID/);
    expect(sql).toMatch(/Drivers can view own document attachments/);
    expect(sql).toMatch(/driver_document_attachments_ssot/);
    // Path stays under auth.uid ownership (existing bucket policy pattern).
    expect(sql).toMatch(/split_part\(v_path, '\/', 1\) IS DISTINCT FROM v_uid::text/);
  });
});
