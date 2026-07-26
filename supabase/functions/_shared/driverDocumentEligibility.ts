import { isDocumentExpiredLondon } from "./documentExpiryLondon.ts";
import { DRIVER_BLOCKED_REASON } from "./driverEligibility.ts";
const PENDING_STATUSES = new Set([
  "pending",
  "uploaded",
  "submitted"
]);
const REJECTED_STATUSES = new Set([
  "rejected",
  "declined"
]);
const RESUBMISSION_STATUSES = new Set([
  "resubmission_required",
  "resubmit_required",
  "requires_resubmission"
]);
function normalizeDocumentStatus(status) {
  return String(status ?? "").toLowerCase().trim();
}
function isRejectedStatus(status) {
  return REJECTED_STATUSES.has(status);
}
function isResubmissionStatus(status) {
  return RESUBMISSION_STATUSES.has(status);
}
/** Expired when expiry_date < today in Europe/London (valid through end of expiry day). */ function isExpired(expiryDate, now) {
  return isDocumentExpiredLondon(expiryDate, now);
}
/** Match SQL get_driver_document_eligibility: prefer approved, then newest updated_at. */ function pickBestDocumentForSlug(documents, slug) {
  const candidates = documents.filter((doc)=>doc.document_type === slug);
  if (candidates.length === 0) return undefined;
  const rank = (doc)=>{
    const status = normalizeDocumentStatus(doc.status);
    const approvedRank = status === "approved" ? 0 : 1;
    const updatedMs = doc.updated_at ? new Date(doc.updated_at).getTime() : doc.created_at ? new Date(doc.created_at).getTime() : 0;
    return [
      approvedRank,
      -updatedMs
    ];
  };
  return [
    ...candidates
  ].sort((a, b)=>{
    const [approvedA, updatedA] = rank(a);
    const [approvedB, updatedB] = rank(b);
    if (approvedA !== approvedB) return approvedA - approvedB;
    return updatedA - updatedB;
  })[0];
}
/** Pure evaluator — mirrors `get_driver_document_eligibility` classification. */ export function evaluateDriverDocumentStateFromSnapshot(args) {
  const now = args.now ?? new Date();
  const requiredRules = args.requiredRules ?? (args.requiredSlugs ?? []).map((slug)=>({
      slug,
      expiry_required: true
    }));
  const missing_documents = [];
  const expired_documents = [];
  const rejected_documents = [];
  const resubmission_documents = [];
  const pending_documents = [];
  let approvedValidCount = 0;
  for (const rule of requiredRules){
    const slug = rule.slug;
    const doc = pickBestDocumentForSlug(args.documents, slug);
    if (!doc) {
      missing_documents.push(slug);
      continue;
    }
    const status = normalizeDocumentStatus(doc.status);
    if (isRejectedStatus(status)) {
      rejected_documents.push(slug);
      continue;
    }
    if (isResubmissionStatus(status)) {
      resubmission_documents.push(slug);
      continue;
    }
    if (rule.expiry_required && (doc.expiry_date == null || isExpired(doc.expiry_date, now))) {
      expired_documents.push(slug);
      continue;
    }
    if (PENDING_STATUSES.has(status)) {
      pending_documents.push(slug);
      continue;
    }
    if (status === "approved") {
      approvedValidCount++;
      continue;
    }
    pending_documents.push(slug);
  }
  const allRequiredApproved = requiredRules.length === 0 || approvedValidCount === requiredRules.length && missing_documents.length === 0 && rejected_documents.length === 0 && resubmission_documents.length === 0 && expired_documents.length === 0 && pending_documents.length === 0;
  let document_state;
  let blocked_reasons = [];
  let message;
  const saLabel = args.serviceAreaName ?? "your assigned service area";
  let code = null;
  if (allRequiredApproved) {
    document_state = "documents_approved";
    message = "";
  } else if (rejected_documents.length > 0) {
    document_state = "documents_rejected";
    blocked_reasons = [
      DRIVER_BLOCKED_REASON.DOCUMENTS_REJECTED
    ];
    code = DRIVER_BLOCKED_REASON.DOCUMENTS_REJECTED;
    message = `Rejected documents for ${saLabel}: ${rejected_documents.join(", ")}`;
  } else if (resubmission_documents.length > 0) {
    document_state = "documents_rejected";
    blocked_reasons = [
      DRIVER_BLOCKED_REASON.DOCUMENTS_REJECTED
    ];
    code = DRIVER_BLOCKED_REASON.DOCUMENTS_REJECTED;
    message = `Documents require resubmission for ${saLabel}: ${resubmission_documents.join(", ")}`;
  } else if (expired_documents.length > 0) {
    document_state = "documents_expired";
    blocked_reasons = [
      DRIVER_BLOCKED_REASON.DOCUMENTS_EXPIRED
    ];
    code = DRIVER_BLOCKED_REASON.DOCUMENTS_EXPIRED;
    message = `Expired documents for ${saLabel}: ${expired_documents.join(", ")}`;
  } else if (missing_documents.length > 0) {
    document_state = "documents_missing";
    blocked_reasons = [
      DRIVER_BLOCKED_REASON.DOCUMENTS_MISSING
    ];
    code = DRIVER_BLOCKED_REASON.DOCUMENTS_MISSING;
    message = `Missing documents for ${saLabel}: ${missing_documents.join(", ")}`;
  } else if (pending_documents.length > 0) {
    document_state = "documents_pending_review";
    blocked_reasons = [
      DRIVER_BLOCKED_REASON.DOCUMENTS_PENDING_REVIEW
    ];
    code = DRIVER_BLOCKED_REASON.DOCUMENTS_PENDING_REVIEW;
    message = `Documents pending review for ${saLabel}: ${pending_documents.join(", ")}`;
  } else {
    document_state = "documents_uploaded";
    blocked_reasons = [
      DRIVER_BLOCKED_REASON.DOCUMENTS_PENDING_REVIEW
    ];
    code = DRIVER_BLOCKED_REASON.DOCUMENTS_PENDING_REVIEW;
    message = `Your documents are being reviewed for ${saLabel}.`;
  }
  return {
    allowed: allRequiredApproved,
    document_state,
    missing_documents,
    expired_documents,
    rejected_documents,
    resubmission_documents,
    pending_documents,
    blocked_reasons,
    message,
    service_area_id: args.serviceAreaId ?? null,
    service_area_name: args.serviceAreaName ?? null,
    code
  };
}
export function hasRequiredDocuments(result) {
  return result.missing_documents.length === 0;
}
export function hasExpiredDocuments(result) {
  return result.expired_documents.length > 0;
}
export function hasRejectedDocuments(result) {
  return result.rejected_documents.length > 0;
}
export function areDocumentsApproved(result) {
  return result.document_state === "documents_approved";
}
export function assertDocumentsApproved(result) {
  if (areDocumentsApproved(result)) return {
    ok: true
  };
  return {
    ok: false,
    result
  };
}
export function documentStateToBlockedReasons(result) {
  return result.blocked_reasons.length ? [
    ...result.blocked_reasons
  ] : [
    DRIVER_BLOCKED_REASON.DOCUMENTS_PENDING_REVIEW
  ];
}
async function loadAssignedServiceArea(service, driverId) {
  const { data } = await service.from("drivers").select("service_area_id, service_areas(name)").eq("id", driverId).maybeSingle();
  const joined = data?.service_areas;
  const name = Array.isArray(joined) ? joined[0]?.name : joined?.name;
  return {
    service_area_id: data?.service_area_id ?? null,
    service_area_name: name ?? null
  };
}
/**
 * Required docs for drivers.service_area_id only.
 * No global fallback. No union across driver_service_areas.
 */ async function loadRequiredDocumentRulesForAssignedServiceArea(service, serviceAreaId) {
  const { data: allRules } = await service.from("service_area_document_rules").select("doc_type_id, mandatory, expiry_required, display_in_driver_app, is_active").eq("service_area_id", serviceAreaId);
  // Configured = any rule rows exist (disabled rules mean not required).
  const rulesConfigured = (allRules ?? []).length > 0;
  if (!rulesConfigured) {
    return {
      rulesConfigured: false,
      requiredRules: []
    };
  }
  const mandatoryRules = (allRules ?? []).filter((r)=>r.is_active === true && r.mandatory === true && r.display_in_driver_app !== false);
  if (mandatoryRules.length === 0) {
    return {
      rulesConfigured: true,
      requiredRules: []
    };
  }
  const typeIds = mandatoryRules.map((r)=>r.doc_type_id).filter(Boolean);
  const { data: types } = await service.from("document_types").select("id, slug").in("id", typeIds).eq("is_active", true);
  const typeById = new Map((types ?? []).map((t)=>[
      t.id,
      t.slug
    ]));
  const requiredRules = [];
  for (const rule of mandatoryRules){
    const slug = typeById.get(rule.doc_type_id);
    if (!slug) continue;
    requiredRules.push({
      slug,
      expiry_required: rule.expiry_required !== false
    });
  }
  return {
    rulesConfigured: true,
    requiredRules
  };
}
export async function evaluateDriverDocumentState(service, driverId) {
  const assigned = await loadAssignedServiceArea(service, driverId);
  if (!assigned.service_area_id) {
    return {
      allowed: false,
      document_state: "documents_missing",
      missing_documents: [],
      expired_documents: [],
      rejected_documents: [],
      resubmission_documents: [],
      pending_documents: [],
      blocked_reasons: [
        DRIVER_BLOCKED_REASON.DRIVER_SERVICE_AREA_NOT_ASSIGNED
      ],
      message: "Driver has no assigned service area. Assign a service area before going online.",
      service_area_id: null,
      service_area_name: null,
      code: DRIVER_BLOCKED_REASON.DRIVER_SERVICE_AREA_NOT_ASSIGNED
    };
  }
  const { rulesConfigured, requiredRules } = await loadRequiredDocumentRulesForAssignedServiceArea(service, assigned.service_area_id);
  if (!rulesConfigured) {
    return {
      allowed: false,
      document_state: "documents_missing",
      missing_documents: [],
      expired_documents: [],
      rejected_documents: [],
      resubmission_documents: [],
      pending_documents: [],
      blocked_reasons: [
        DRIVER_BLOCKED_REASON.SERVICE_AREA_DOCUMENT_RULES_NOT_CONFIGURED
      ],
      message: `Document rules are not configured for service area ${assigned.service_area_name ?? assigned.service_area_id}.`,
      service_area_id: assigned.service_area_id,
      service_area_name: assigned.service_area_name,
      code: DRIVER_BLOCKED_REASON.SERVICE_AREA_DOCUMENT_RULES_NOT_CONFIGURED
    };
  }
  const { data: documents } = await service.from("documents").select("document_type, status, expiry_date, rejection_reason, created_at, updated_at").eq("driver_id", driverId);
  return evaluateDriverDocumentStateFromSnapshot({
    requiredRules,
    documents: documents ?? [],
    serviceAreaId: assigned.service_area_id,
    serviceAreaName: assigned.service_area_name
  });
}
