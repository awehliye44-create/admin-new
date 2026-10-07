/**
 * Admin review of driver vehicle change requests.
 * Server SSOT: admin_get_vehicle_change_review / admin_decide_vehicle_change_request
 * (migration 20261214120000_driver_vehicle_change_request_flow.sql).
 */

export type VehicleChangeStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

export type VehicleDetails = {
  make: string | null;
  model: string | null;
  year: number | null;
  colour: string | null;
  licence_plate: string | null;
};

export type ReviewDocument = {
  slug: string;
  name: string;
  state: 'approved' | 'missing' | 'expired' | 'rejected' | 'pending';
  document_id: string | null;
  document_status: string | null;
  expiry_date: string | null;
  file_url: string | null;
  reviewed_at: string | null;
  uploaded_at: string | null;
  expiring_soon: boolean;
};

export type ReviewCategory = {
  vehicle_type_id: string;
  name: string;
  slug: string | null;
  is_default: boolean;
  driver_controllable: boolean;
  enabled: boolean;
};

export type VehicleChangeReview = {
  request: {
    id: string;
    status: VehicleChangeStatus;
    requested: VehicleDetails;
    previous: VehicleDetails;
    rejection_reason: string | null;
    admin_notes: string | null;
    created_at: string;
  };
  currentVehicle: (VehicleDetails & { id: string; belongs_to_driver: boolean }) | null;
  documentRulesAvailable: boolean;
  documentRulesCode: string | null;
  documents: ReviewDocument[];
  categories: ReviewCategory[];
};

type UnknownRecord = Record<string, unknown>;

const asRecord = (v: unknown): UnknownRecord | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as UnknownRecord) : null;
const asString = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const asNumber = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function parseDetails(v: unknown): VehicleDetails {
  const r = asRecord(v) ?? {};
  return {
    make: asString(r.make),
    model: asString(r.model),
    year: asNumber(r.year),
    colour: asString(r.colour),
    licence_plate: asString(r.licence_plate),
  };
}

const DOCUMENT_STATES = new Set(['approved', 'missing', 'expired', 'rejected', 'pending']);
const STATUSES = new Set(['pending', 'approved', 'rejected', 'cancelled']);

export function parseVehicleChangeReview(payload: unknown): VehicleChangeReview | null {
  const root = asRecord(payload);
  if (!root || root.ok !== true) return null;
  const req = asRecord(root.request);
  const id = asString(req?.id);
  const status = asString(req?.status);
  if (!req || !id || !status || !STATUSES.has(status)) return null;

  const vehicle = asRecord(root.current_vehicle);
  const docsRoot = asRecord(root.vehicle_documents) ?? {};
  const documents = (Array.isArray(docsRoot.documents) ? docsRoot.documents : [])
    .map((d): ReviewDocument | null => {
      const r = asRecord(d);
      const slug = asString(r?.slug);
      const state = asString(r?.state);
      if (!r || !slug || !state || !DOCUMENT_STATES.has(state)) return null;
      return {
        slug,
        name: asString(r.name) ?? slug,
        state: state as ReviewDocument['state'],
        document_id: asString(r.document_id),
        document_status: asString(r.document_status),
        expiry_date: asString(r.expiry_date),
        file_url: asString(r.file_url),
        reviewed_at: asString(r.reviewed_at),
        uploaded_at: asString(r.uploaded_at),
        expiring_soon: r.expiring_soon === true,
      };
    })
    .filter((d): d is ReviewDocument => d !== null);

  const categories = (Array.isArray(root.categories) ? root.categories : [])
    .map((c): ReviewCategory | null => {
      const r = asRecord(c);
      const vehicleTypeId = asString(r?.vehicle_type_id);
      if (!r || !vehicleTypeId) return null;
      return {
        vehicle_type_id: vehicleTypeId,
        name: asString(r.name) ?? 'Category',
        slug: asString(r.slug),
        is_default: r.is_default === true,
        driver_controllable: r.driver_controllable === true,
        enabled: r.enabled === true,
      };
    })
    .filter((c): c is ReviewCategory => c !== null);

  return {
    request: {
      id,
      status: status as VehicleChangeStatus,
      requested: parseDetails(req.requested),
      previous: parseDetails(req.previous),
      rejection_reason: asString(req.rejection_reason),
      admin_notes: asString(req.admin_notes),
      created_at: asString(req.created_at) ?? '',
    },
    currentVehicle: vehicle && asString(vehicle.id)
      ? {
          ...parseDetails(vehicle),
          id: asString(vehicle.id) as string,
          belongs_to_driver: vehicle.belongs_to_driver === true,
        }
      : null,
    documentRulesAvailable: docsRoot.rules_available === true,
    documentRulesCode: asString(docsRoot.code),
    documents,
    categories,
  };
}

/** Fields that differ between the vehicle at submission and the requested one. */
export function changedVehicleFields(review: VehicleChangeReview): Array<keyof VehicleDetails> {
  const keys: Array<keyof VehicleDetails> = ['make', 'model', 'year', 'colour', 'licence_plate'];
  const norm = (k: keyof VehicleDetails, v: VehicleDetails[keyof VehicleDetails]) =>
    k === 'licence_plate'
      ? String(v ?? '').replace(/\s+/g, '').toUpperCase()
      : String(v ?? '').trim().toLowerCase();
  return keys.filter(
    (k) => norm(k, review.request.previous[k]) !== norm(k, review.request.requested[k]),
  );
}

export type ApprovalReadiness =
  | { ready: true }
  | { ready: false; reason: string };

/**
 * Mirrors the server gates so the button explains what is missing.
 * The server re-checks everything; this never replaces it.
 */
export function approvalReadiness(
  review: VehicleChangeReview,
  reviewedDocumentIds: ReadonlySet<string>,
  enabledCategoryIds: ReadonlySet<string>,
): ApprovalReadiness {
  if (review.request.status !== 'pending') {
    return { ready: false, reason: 'This request has already been decided.' };
  }
  if (!review.documentRulesAvailable) {
    return {
      ready: false,
      reason: 'Document rules are not configured for this driver’s service area.',
    };
  }
  const notCompliant = review.documents.filter((d) => d.state !== 'approved' || !d.document_id);
  if (notCompliant.length > 0) {
    return {
      ready: false,
      reason: `Vehicle documents not compliant: ${notCompliant.map((d) => `${d.name} (${d.state})`).join(', ')}.`,
    };
  }
  const unreviewed = review.documents.filter(
    (d) => d.document_id && !reviewedDocumentIds.has(d.document_id),
  );
  if (unreviewed.length > 0) {
    return {
      ready: false,
      reason: `Confirm you reviewed: ${unreviewed.map((d) => d.name).join(', ')}.`,
    };
  }
  if (enabledCategoryIds.size === 0) {
    return { ready: false, reason: 'Keep at least one ride category for the new vehicle.' };
  }
  return { ready: true };
}

const DECISION_MESSAGES: Record<string, string> = {
  NOT_FOUND: 'This request no longer exists.',
  ALREADY_DECIDED: 'This request has already been decided.',
  INVALID_DECISION: 'Choose approve or reject.',
  REJECTION_REASON_REQUIRED: 'Enter a reason for the driver before rejecting.',
  DRIVER_NOT_ACTIVE: 'The driver account is no longer active.',
  VEHICLE_OWNERSHIP_MISMATCH: 'The vehicle no longer belongs to this driver.',
  VEHICLE_CHANGED_SINCE_REQUEST:
    'The vehicle was changed after this request was submitted. Reject it and ask the driver to submit again.',
  VEHICLE_OWNERSHIP_CONFLICT: 'Another driver already has a vehicle with this registration.',
  DOCUMENT_RULES_UNAVAILABLE: 'Document rules are not configured for this driver’s service area.',
  VEHICLE_DOCUMENTS_NOT_COMPLIANT: 'Some vehicle documents are missing, expired, pending or rejected.',
  VEHICLE_DOCUMENTS_NOT_REVIEWED:
    'The vehicle documents changed since you opened this request. Reload and review them again.',
  CATEGORY_RECHECK_REQUIRED: 'Confirm the ride categories for the new vehicle.',
  UNKNOWN_VEHICLE_CATEGORY: 'One of the selected ride categories is no longer active.',
  NO_ELIGIBLE_CATEGORY: 'Keep at least one ride category for the new vehicle.',
};

export function vehicleChangeDecisionMessage(code: string | null | undefined): string {
  return (code && DECISION_MESSAGES[code]) || 'Could not save the decision. Please try again.';
}

export function formatVehicle(v: VehicleDetails | null | undefined): string {
  if (!v) return '—';
  const name = [v.year, v.make, v.model].filter((x) => x !== null && x !== '').join(' ');
  return name || '—';
}
