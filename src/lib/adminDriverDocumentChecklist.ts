/**
 * Admin Add Documents checklist composition — mirrors Driver My Documents:
 * active SA rules (display_in_driver_app) + compliance SSOT merge + synthetic
 * missing optionals. Does not redefine the compliance SSOT view.
 */

import type { DriverDocumentComplianceRow } from '@/hooks/useDriverDocumentCompliance';
import { resolveAdminDocumentCaptureLayout } from '@/lib/adminDocumentCaptureSides';

export type ServiceAreaDocumentRule = {
  doc_type_id: string;
  display_in_driver_app: boolean | null;
  mandatory: boolean | null;
  expiry_required: boolean | null;
  sort_order: number | null;
  is_active: boolean | null;
};

export type DocumentTypeMeta = {
  id: string;
  slug: string;
  name: string;
  is_required: boolean;
  has_expiry: boolean;
  is_active: boolean;
};

export type AdminChecklistStatus =
  | 'missing'
  | 'not_uploaded'
  | 'pending_review'
  | 'approved'
  | 'rejected'
  | 'expired'
  | 'expiring_soon';

/** Matches public.vehicle_change_document_slugs(). */
export const VEHICLE_SCOPED_DOCUMENT_SLUGS = [
  'v5_logbook',
  'mot_certificate',
  'phv_license',
  'private_hire_insurance',
  'additional_insurance_document',
  'exemption_certificate',
] as const;

export function isVehicleScopedDocumentSlug(slug: string | null | undefined): boolean {
  return (VEHICLE_SCOPED_DOCUMENT_SLUGS as readonly string[]).includes(slug ?? '');
}

export type VehicleDocumentSnapshot = {
  id: string;
  document_type_id: string;
  vehicle_id: string | null;
  status: string | null;
  expiry_date: string | null;
  is_current: boolean | null;
};

export type AdminChecklistRow = {
  document_type_id: string;
  document_type_key: string;
  display_name: string;
  is_required: boolean;
  requires_expiry: boolean;
  sort_order: number;
  status: AdminChecklistStatus;
  status_label: string;
  requirement_label: 'Required' | 'Optional';
  can_upload: boolean;
  vehicle_scoped: boolean;
  capture: ReturnType<typeof resolveAdminDocumentCaptureLayout>;
  /** Underlying SSOT row when present (null for synthesized missing optionals). */
  compliance: DriverDocumentComplianceRow | null;
};

function syntheticMissingCompliance(
  driverId: string,
  meta: DocumentTypeMeta,
  isRequired: boolean,
  requiresExpiry: boolean,
): DriverDocumentComplianceRow {
  return {
    driver_id: driverId,
    document_type_id: meta.id,
    document_type_key: meta.slug,
    display_name: meta.name,
    is_required: isRequired,
    has_expiry: requiresExpiry,
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
    blocks_online: isRequired,
    can_upload_replacement: true,
    renewal_state: 'missing',
    renewal_open_days: null,
  };
}

function applyServiceAreaRule(
  row: DriverDocumentComplianceRow,
  rule: ServiceAreaDocumentRule,
): DriverDocumentComplianceRow {
  if (rule.mandatory == null) return row;
  if (rule.mandatory) {
    return { ...row, is_required: true };
  }
  return { ...row, is_required: false, blocks_online: false };
}

export function resolveAdminChecklistStatus(
  row: DriverDocumentComplianceRow,
): { status: AdminChecklistStatus; label: string } {
  const expiry = (row.expiry_status ?? '').toLowerCase();
  const approval = (row.approval_status ?? '').toLowerCase();

  if (!row.document_id || expiry === 'missing') {
    return {
      status: row.is_required ? 'missing' : 'not_uploaded',
      label: row.is_required ? 'Missing' : 'Not uploaded',
    };
  }
  if (expiry === 'rejected' || approval === 'rejected' || approval === 'declined') {
    return { status: 'rejected', label: 'Rejected' };
  }
  if (
    expiry === 'pending' ||
    approval === 'pending' ||
    approval === 'uploaded' ||
    approval === 'submitted' ||
    approval === 'under_review'
  ) {
    // Driver My Documents statusLabel: "Pending review"
    return { status: 'pending_review', label: 'Pending review' };
  }
  if (expiry === 'expired' || approval === 'expired') {
    return { status: 'expired', label: 'Expired' };
  }
  if (expiry === 'expiring_soon') {
    // Driver My Documents statusLabel: "Expiring soon"
    return { status: 'expiring_soon', label: 'Expiring soon' };
  }
  if (expiry === 'approved_valid' || approval === 'approved') {
    return { status: 'approved', label: 'Approved' };
  }
  return { status: 'pending_review', label: 'Pending review' };
}

/**
 * Driver My Documents badge tones (onecab-driver-native DocumentStatusBadge /
 * theme tokens statusCompleted* / statusNoShow* / statusCancelled*).
 */
export type AdminChecklistStatusTone = {
  backgroundColor: string;
  color: string;
};

export function adminChecklistStatusTone(
  status: AdminChecklistStatus,
): AdminChecklistStatusTone {
  switch (status) {
    case 'approved':
      return { backgroundColor: '#E8F6EC', color: '#2F7D46' };
    case 'pending_review':
    case 'expiring_soon':
      return { backgroundColor: '#FBF0D6', color: '#B7811A' };
    case 'rejected':
    case 'expired':
      return { backgroundColor: '#F8E4E3', color: '#C0392B' };
    case 'not_uploaded':
      return { backgroundColor: '#F2F2F0', color: '#5F5F5F' };
    case 'missing':
    default:
      return { backgroundColor: '#E8EEF7', color: '#3B6EA5' };
  }
}

export function resolveAdminChecklistUploadEligible(
  row: DriverDocumentComplianceRow,
): boolean {
  if (row.can_upload_replacement === true) return true;
  const status = (row.expiry_status ?? '').toLowerCase();
  return (
    status === 'missing' ||
    status === 'rejected' ||
    status === 'expired' ||
    status === 'pending'
  );
}

/**
 * Compose the Admin checklist from SA rules + compliance SSOT rows.
 * Visible rules: is_active + display_in_driver_app (same as Driver My Documents).
 */
function vehicleDocCompliance(
  driverId: string,
  meta: DocumentTypeMeta,
  isRequired: boolean,
  requiresExpiry: boolean,
  doc: VehicleDocumentSnapshot | undefined,
): DriverDocumentComplianceRow {
  const base = syntheticMissingCompliance(driverId, meta, isRequired, requiresExpiry);
  if (!doc) {
    return { ...base, can_upload_replacement: true };
  }
  const approval = (doc.status ?? '').toLowerCase();
  let expiryStatus = 'pending';
  if (approval === 'rejected' || approval === 'declined') expiryStatus = 'rejected';
  else if (approval === 'expired') expiryStatus = 'expired';
  else if (approval === 'approved') {
    const today = new Date().toISOString().slice(0, 10);
    expiryStatus = doc.expiry_date && doc.expiry_date < today ? 'expired' : 'approved_valid';
  } else if (
    approval === 'pending' ||
    approval === 'uploaded' ||
    approval === 'submitted' ||
    approval === 'under_review'
  ) {
    expiryStatus = 'pending';
  }
  const open =
    expiryStatus === 'missing' ||
    expiryStatus === 'rejected' ||
    expiryStatus === 'expired' ||
    expiryStatus === 'pending';
  return {
    ...base,
    document_id: doc.id,
    approval_status: doc.status,
    expiry_date: doc.expiry_date,
    expiry_status: expiryStatus,
    is_current: true,
    can_upload_replacement: open,
  };
}

export function composeAdminDriverDocumentChecklist(input: {
  driverId: string;
  rules: ServiceAreaDocumentRule[];
  typeMetaById: Map<string, DocumentTypeMeta>;
  complianceRows: DriverDocumentComplianceRow[];
  /** When set, vehicle-scoped rows use this vehicle's documents, not the trip-active list. */
  selectedVehicleId?: string | null;
  vehicleDocuments?: VehicleDocumentSnapshot[];
}): AdminChecklistRow[] {
  const visibleRules = input.rules.filter(
    (r) => r.is_active === true && r.display_in_driver_app === true,
  );

  const ssotByType = new Map<string, DriverDocumentComplianceRow>();
  for (const row of input.complianceRows) {
    if (!row.document_type_id) continue;
    // Prefer current / non-superseded when duplicates appear.
    const existing = ssotByType.get(row.document_type_id);
    if (!existing || (row.is_current && !existing.is_current)) {
      ssotByType.set(row.document_type_id, row);
    }
  }

  const rows: AdminChecklistRow[] = [];

  for (const rule of visibleRules) {
    const meta = input.typeMetaById.get(rule.doc_type_id);
    if (!meta || !meta.is_active) continue;

    const isRequired = rule.mandatory != null ? Boolean(rule.mandatory) : meta.is_required;
    const requiresExpiry =
      rule.expiry_required != null ? Boolean(rule.expiry_required) : meta.has_expiry;
    const vehicleScoped = isVehicleScopedDocumentSlug(meta.slug);
    const scopeToVehicle =
      input.selectedVehicleId !== undefined || input.vehicleDocuments !== undefined;

    const existing = ssotByType.get(rule.doc_type_id);
    const vehicleDoc = vehicleScoped
      ? input.vehicleDocuments?.find(
          (doc) =>
            doc.vehicle_id === input.selectedVehicleId &&
            doc.document_type_id === rule.doc_type_id &&
            doc.is_current !== false,
        )
      : undefined;
    const base =
      vehicleScoped && scopeToVehicle
        ? input.selectedVehicleId
          ? vehicleDocCompliance(input.driverId, meta, isRequired, requiresExpiry, vehicleDoc)
          : {
              ...syntheticMissingCompliance(input.driverId, meta, isRequired, requiresExpiry),
              can_upload_replacement: false,
            }
        : existing ??
          syntheticMissingCompliance(input.driverId, meta, isRequired, requiresExpiry);
    const withSa = applyServiceAreaRule(
      {
        ...base,
        has_expiry: requiresExpiry,
        display_name: meta.name,
        document_type_key: meta.slug,
      },
      rule,
    );

    const { status, label } = resolveAdminChecklistStatus(withSa);
    const canUpload = resolveAdminChecklistUploadEligible(withSa);
    const capture = resolveAdminDocumentCaptureLayout({
      code: withSa.document_type_key,
      name: withSa.display_name,
    });

    rows.push({
      document_type_id: withSa.document_type_id,
      document_type_key: withSa.document_type_key,
      display_name: withSa.display_name,
      is_required: withSa.is_required,
      requires_expiry: requiresExpiry,
      sort_order: rule.sort_order ?? 999,
      status,
      status_label: label,
      requirement_label: withSa.is_required ? 'Required' : 'Optional',
      can_upload:
        vehicleScoped && scopeToVehicle && !input.selectedVehicleId ? false : canUpload,
      vehicle_scoped: vehicleScoped,
      capture,
      compliance: existing ?? null,
    });
  }

  return rows.sort(
    (a, b) =>
      a.sort_order - b.sort_order ||
      Number(b.is_required) - Number(a.is_required) ||
      a.display_name.localeCompare(b.display_name),
  );
}
