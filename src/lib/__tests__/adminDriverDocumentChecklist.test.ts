import { describe, expect, it } from 'vitest';
import {
  adminChecklistStatusTone,
  composeAdminDriverDocumentChecklist,
  resolveAdminChecklistStatus,
  resolveAdminChecklistUploadEligible,
  type DocumentTypeMeta,
  type ServiceAreaDocumentRule,
} from '@/lib/adminDriverDocumentChecklist';
import type { DriverDocumentComplianceRow } from '@/hooks/useDriverDocumentCompliance';

const DRIVER = 'e2fc18cd-afa9-4c39-bdc5-b84a26654a77';

function meta(
  id: string,
  slug: string,
  name: string,
  opts: Partial<DocumentTypeMeta> = {},
): DocumentTypeMeta {
  return {
    id,
    slug,
    name,
    is_required: true,
    has_expiry: false,
    is_active: true,
    ...opts,
  };
}

function rule(
  doc_type_id: string,
  opts: Partial<ServiceAreaDocumentRule> & { sort_order: number },
): ServiceAreaDocumentRule {
  return {
    doc_type_id,
    display_in_driver_app: true,
    mandatory: true,
    expiry_required: false,
    is_active: true,
    ...opts,
  };
}

function ssot(
  partial: Partial<DriverDocumentComplianceRow> & {
    document_type_id: string;
    document_type_key: string;
    display_name: string;
  },
): DriverDocumentComplianceRow {
  return {
    driver_id: DRIVER,
    is_required: true,
    has_expiry: false,
    document_id: null,
    approval_status: null,
    expiry_date: null,
    file_url: null,
    last_updated_at: null,
    replacement_document_id: null,
    is_current: false,
    is_superseded: false,
    expiry_status: 'missing',
    days_until_expiry: null,
    blocks_online: true,
    can_upload_replacement: true,
    renewal_state: 'missing',
    renewal_open_days: null,
    ...partial,
  };
}

describe('adminDriverDocumentChecklist', () => {
  it('MK0014-shaped Milton Keynes catalogue matches Driver My Documents composition', () => {
    const ids = {
      phi: 't-phi',
      mot: 't-mot',
      phv: 't-phv',
      phd: 't-phd',
      phl: 't-phl',
      dvla: 't-dvla',
      photo: 't-photo',
      v5: 't-v5',
      ni: 't-ni',
      addl: 't-addl',
      exempt: 't-exempt',
      bank: 't-bank',
      dvlaCode: 't-dvla-code',
      // Non-applicable for Driver app / SA visibility
      utr: 't-utr',
      oldLicense: 't-old-license',
      oldCheck: 't-old-check',
    };

    const typeMetaById = new Map<string, DocumentTypeMeta>([
      [ids.phi, meta(ids.phi, 'private_hire_insurance', 'Private Hire Insurance Certificate', { has_expiry: true })],
      [ids.mot, meta(ids.mot, 'mot_certificate', 'MOT Test Certificate', { has_expiry: true })],
      [ids.phv, meta(ids.phv, 'phv_license', 'PHV (Private Hire Vehicle License)', { has_expiry: true })],
      [ids.phd, meta(ids.phd, 'phd_badge', 'PHD Badge (Private Hire Driver Badge)', { has_expiry: true })],
      [ids.phl, meta(ids.phl, 'phl_license', 'PHL (Private Hire Driver License)', { has_expiry: true })],
      [ids.dvla, meta(ids.dvla, 'dvla_driving_license', 'DVLA Driving Licence - Front', { has_expiry: true })],
      [ids.photo, meta(ids.photo, 'profile_photo', 'Profile Photo')],
      [ids.v5, meta(ids.v5, 'v5_logbook', 'V5 Logbook (Full)')],
      [ids.ni, meta(ids.ni, 'national_insurance', 'National Insurance Number')],
      [ids.addl, meta(ids.addl, 'additional_insurance_document', 'Insurance Supporting Documents', { is_required: false, has_expiry: true })],
      [ids.exempt, meta(ids.exempt, 'exemption_certificate', 'Exemption certificate', { is_required: false, has_expiry: true })],
      [ids.bank, meta(ids.bank, 'bank_statement', 'Bank Statement')],
      [ids.dvlaCode, meta(ids.dvlaCode, 'dvla_electronic_counterpart_check_code', 'DVLA Electronic Counterpart Check Code', { is_required: false })],
      [ids.utr, meta(ids.utr, 'utr_number', 'UTR (Unique Taxpayer Reference)')],
      [ids.oldLicense, meta(ids.oldLicense, 'driver_license', 'Driver license')],
      [ids.oldCheck, meta(ids.oldCheck, 'dvla_check_code', 'DVLA Electronic Counterpart Check Code')],
    ]);

    const rules: ServiceAreaDocumentRule[] = [
      rule(ids.phi, { sort_order: 1, expiry_required: true }),
      rule(ids.mot, { sort_order: 2, expiry_required: true }),
      rule(ids.phv, { sort_order: 3, expiry_required: true }),
      rule(ids.oldCheck, { sort_order: 4, is_active: false, display_in_driver_app: false, expiry_required: false }),
      rule(ids.phd, { sort_order: 5, expiry_required: true }),
      rule(ids.phl, { sort_order: 6, expiry_required: true }),
      rule(ids.dvla, { sort_order: 7, expiry_required: true }),
      rule(ids.photo, { sort_order: 8 }),
      rule(ids.v5, { sort_order: 9 }),
      rule(ids.utr, { sort_order: 10, mandatory: false, display_in_driver_app: false }),
      rule(ids.ni, { sort_order: 11 }),
      rule(ids.oldLicense, { sort_order: 12, is_active: false, display_in_driver_app: false }),
      rule(ids.addl, { sort_order: 13, mandatory: false, expiry_required: true }),
      rule(ids.exempt, { sort_order: 15, mandatory: false, expiry_required: true }),
      rule(ids.bank, { sort_order: 16 }),
      rule(ids.dvlaCode, { sort_order: 17, mandatory: false }),
    ];

    // SSOT omits the three optionals (view only emits required or submitted).
    const complianceRows = [
      ssot({ document_type_id: ids.phi, document_type_key: 'private_hire_insurance', display_name: 'Private Hire Insurance Certificate', has_expiry: true }),
      ssot({ document_type_id: ids.mot, document_type_key: 'mot_certificate', display_name: 'MOT Test Certificate', has_expiry: true }),
      ssot({ document_type_id: ids.phv, document_type_key: 'phv_license', display_name: 'PHV (Private Hire Vehicle License)', has_expiry: true }),
      ssot({ document_type_id: ids.phd, document_type_key: 'phd_badge', display_name: 'PHD Badge (Private Hire Driver Badge)', has_expiry: true }),
      ssot({ document_type_id: ids.phl, document_type_key: 'phl_license', display_name: 'PHL (Private Hire Driver License)', has_expiry: true }),
      ssot({ document_type_id: ids.dvla, document_type_key: 'dvla_driving_license', display_name: 'DVLA Driving Licence - Front', has_expiry: true }),
      ssot({ document_type_id: ids.photo, document_type_key: 'profile_photo', display_name: 'Profile Photo' }),
      ssot({ document_type_id: ids.v5, document_type_key: 'v5_logbook', display_name: 'V5 Logbook (Full)' }),
      ssot({ document_type_id: ids.ni, document_type_key: 'national_insurance', display_name: 'National Insurance Number' }),
      ssot({ document_type_id: ids.bank, document_type_key: 'bank_statement', display_name: 'Bank Statement' }),
      // Non-applicable SSOT noise
      ssot({ document_type_id: ids.utr, document_type_key: 'utr_number', display_name: 'UTR (Unique Taxpayer Reference)' }),
      ssot({ document_type_id: ids.oldLicense, document_type_key: 'driver_license', display_name: 'Driver license' }),
      ssot({ document_type_id: ids.oldCheck, document_type_key: 'dvla_check_code', display_name: 'DVLA Electronic Counterpart Check Code' }),
    ];

    const rows = composeAdminDriverDocumentChecklist({
      driverId: DRIVER,
      rules,
      typeMetaById,
      complianceRows,
    });

    expect(rows).toHaveLength(13);
    expect(rows.map((r) => r.document_type_key)).toEqual([
      'private_hire_insurance',
      'mot_certificate',
      'phv_license',
      'phd_badge',
      'phl_license',
      'dvla_driving_license',
      'profile_photo',
      'v5_logbook',
      'national_insurance',
      'additional_insurance_document',
      'exemption_certificate',
      'bank_statement',
      'dvla_electronic_counterpart_check_code',
    ]);
    expect(rows.map((r) => r.document_type_key)).not.toContain('utr_number');
    expect(rows.map((r) => r.document_type_key)).not.toContain('driver_license');
    expect(rows.map((r) => r.document_type_key)).not.toContain('dvla_check_code');

    const optionals = rows.filter((r) => !r.is_required).map((r) => r.document_type_key);
    expect(optionals).toEqual([
      'additional_insurance_document',
      'exemption_certificate',
      'dvla_electronic_counterpart_check_code',
    ]);
    expect(optionals.every((k) => rows.find((r) => r.document_type_key === k)?.status === 'not_uploaded')).toBe(true);

    const dvla = rows.find((r) => r.document_type_key === 'dvla_driving_license')!;
    expect(dvla.capture.kind).toBe('front_only');
    expect(dvla.requires_expiry).toBe(true);

    const mot = rows.find((r) => r.document_type_key === 'mot_certificate')!;
    expect(mot.capture.kind).toBe('single');
    expect(mot.requirement_label).toBe('Required');
    expect(mot.status_label).toBe('Missing');
  });

  it('keeps approved and pending visible while disabling ineligible uploads', () => {
    const typeId = 't1';
    const typeMetaById = new Map([
      [typeId, meta(typeId, 'mot_certificate', 'MOT Test Certificate', { has_expiry: true })],
    ]);
    const rules = [rule(typeId, { sort_order: 1, expiry_required: true })];

    const approved = composeAdminDriverDocumentChecklist({
      driverId: DRIVER,
      rules,
      typeMetaById,
      complianceRows: [
        ssot({
          document_type_id: typeId,
          document_type_key: 'mot_certificate',
          display_name: 'MOT Test Certificate',
          document_id: 'doc-1',
          approval_status: 'approved',
          expiry_status: 'approved_valid',
          has_expiry: true,
          is_current: true,
          can_upload_replacement: false,
        }),
      ],
    });
    expect(approved).toHaveLength(1);
    expect(approved[0].status).toBe('approved');
    expect(approved[0].can_upload).toBe(false);

    const pending = composeAdminDriverDocumentChecklist({
      driverId: DRIVER,
      rules,
      typeMetaById,
      complianceRows: [
        ssot({
          document_type_id: typeId,
          document_type_key: 'mot_certificate',
          display_name: 'MOT Test Certificate',
          document_id: 'doc-2',
          approval_status: 'pending',
          expiry_status: 'pending',
          has_expiry: true,
          is_current: true,
          can_upload_replacement: false,
        }),
      ],
    });
    expect(pending[0].status).toBe('pending_review');
    expect(pending[0].status_label).toBe('Pending review');
    // Pending is still upload-eligible for same-doc side attach / resubmit in Driver SSOT.
    expect(resolveAdminChecklistUploadEligible(pending[0].compliance!)).toBe(true);
  });

  it('matches Driver My Documents status badge tones', () => {
    expect(adminChecklistStatusTone('approved')).toEqual({
      backgroundColor: '#E8F6EC',
      color: '#2F7D46',
    });
    expect(adminChecklistStatusTone('expiring_soon')).toEqual({
      backgroundColor: '#FBF0D6',
      color: '#B7811A',
    });
    expect(adminChecklistStatusTone('pending_review')).toEqual({
      backgroundColor: '#FBF0D6',
      color: '#B7811A',
    });
    expect(adminChecklistStatusTone('expired')).toEqual({
      backgroundColor: '#F8E4E3',
      color: '#C0392B',
    });
    expect(adminChecklistStatusTone('rejected')).toEqual({
      backgroundColor: '#F8E4E3',
      color: '#C0392B',
    });
    expect(adminChecklistStatusTone('missing')).toEqual({
      backgroundColor: '#E8EEF7',
      color: '#3B6EA5',
    });
    expect(adminChecklistStatusTone('not_uploaded')).toEqual({
      backgroundColor: '#F2F2F0',
      color: '#5F5F5F',
    });
  });

  it('applies a different service-area catalogue dynamically (Banadir-shaped)', () => {
    const a = 'a1';
    const b = 'b1';
    const c = 'c1';
    const typeMetaById = new Map([
      [a, meta(a, 'profile_photo', 'Profile Photo')],
      [b, meta(b, 'bank_statement', 'Bank Statement')],
      [c, meta(c, 'exemption_certificate', 'Exemption certificate', { is_required: false, has_expiry: true })],
    ]);
    const rules = [
      rule(a, { sort_order: 1 }),
      rule(b, { sort_order: 2 }),
      rule(c, { sort_order: 3, mandatory: false, expiry_required: true }),
    ];
    const rows = composeAdminDriverDocumentChecklist({
      driverId: DRIVER,
      rules,
      typeMetaById,
      complianceRows: [],
    });
    expect(rows.map((r) => r.document_type_key)).toEqual([
      'profile_photo',
      'bank_statement',
      'exemption_certificate',
    ]);
    expect(rows[2].is_required).toBe(false);
    expect(rows[2].requires_expiry).toBe(true);
    expect(rows[2].status).toBe('not_uploaded');
  });

  it('uses the selected vehicle documents instead of the trip-active approval', () => {
    const rows = composeAdminDriverDocumentChecklist({
      driverId: DRIVER,
      rules: [rule('t-phi', { sort_order: 1 })],
      typeMetaById: new Map([
        ['t-phi', meta('t-phi', 'private_hire_insurance', 'Insurance', { has_expiry: true })],
      ]),
      complianceRows: [
        ssot({
          document_type_id: 't-phi',
          document_type_key: 'private_hire_insurance',
          display_name: 'Insurance',
          document_id: 'active-doc',
          approval_status: 'approved',
          expiry_status: 'approved_valid',
          is_current: true,
          can_upload_replacement: false,
        }),
      ],
      selectedVehicleId: 'pending-vehicle',
      vehicleDocuments: [
        {
          id: 'old-doc',
          document_type_id: 't-phi',
          vehicle_id: 'old-vehicle',
          status: 'approved',
          expiry_date: null,
          is_current: true,
        },
      ],
    });
    expect(rows[0].vehicle_scoped).toBe(true);
    expect(rows[0].status).toBe('missing');
    expect(rows[0].can_upload).toBe(true);
  });

  it('maps status labels independently of requirement', () => {
    const requiredMissing = ssot({
      document_type_id: 'x',
      document_type_key: 'x',
      display_name: 'X',
      is_required: true,
      expiry_status: 'missing',
    });
    expect(resolveAdminChecklistStatus(requiredMissing)).toEqual({
      status: 'missing',
      label: 'Missing',
    });
    const optionalMissing = { ...requiredMissing, is_required: false };
    expect(resolveAdminChecklistStatus(optionalMissing)).toEqual({
      status: 'not_uploaded',
      label: 'Not uploaded',
    });
  });
});
