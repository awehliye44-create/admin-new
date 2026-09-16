import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { isDocumentExpiredLondon } from "./documentExpiryLondon.ts";
import { DRIVER_BLOCKED_REASON, type DriverBlockedReason } from "./driverEligibility.ts";

/** Canonical driver document states (Phase 4F.6). */
export type DriverDocumentState =
  | "documents_missing"
  | "documents_uploaded"
  | "documents_pending_review"
  | "documents_rejected"
  | "documents_expired"
  | "documents_approved";

export type DocumentRowSnapshot = {
  document_type: string;
  status: string | null;
  expiry_date?: string | null;
  rejection_reason?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

export type RequiredDocumentRule = {
  slug: string;
  expiry_required: boolean;
};

export type DriverDocumentEligibilityResult = {
  allowed: boolean;
  document_state: DriverDocumentState;
  missing_documents: string[];
  expired_documents: string[];
  rejected_documents: string[];
  resubmission_documents: string[];
  pending_documents: string[];
  blocked_reasons: DriverBlockedReason[];
  message: string;
  service_area_id?: string | null;
  service_area_name?: string | null;
  code?: string | null;
};

const PENDING_STATUSES = new Set(["pending", "uploaded", "submitted"]);
const REJECTED_STATUSES = new Set(["rejected", "declined"]);
const RESUBMISSION_STATUSES = new Set([
  "resubmission_required",
  "resubmit_required",
  "requires_resubmission",
]);

function normalizeDocumentStatus(status: string | null | undefined): string {
  return String(status ?? "").toLowerCase().trim();
}

function isRejectedStatus(status: string): boolean {
  return REJECTED_STATUSES.has(status);
}

function isResubmissionStatus(status: string): boolean {
  return RESUBMISSION_STATUSES.has(status);
}

/** Expired when expiry_date < today in Europe/London (valid through end of expiry day). */
function isExpired(expiryDate: string | null | undefined, now: Date): boolean {
  return isDocumentExpiredLondon(expiryDate, now);
}

/** Match SQL get_driver_document_eligibility: prefer approved, then newest updated_at. */
function pickBestDocumentForSlug(
  documents: DocumentRowSnapshot[],
  slug: string,
): DocumentRowSnapshot | undefined {
  const candidates = documents.filter((doc) => doc.document_type === slug);
  if (candidates.length === 0) return undefined;

  const rank = (doc: DocumentRowSnapshot): [number, number] => {
    const status = normalizeDocumentStatus(doc.status);
    const approvedRank = status === "approved" ? 0 : 1;
    const updatedMs = doc.updated_at
      ? new Date(doc.updated_at).getTime()
      : doc.created_at
        ? new Date(doc.created_at).getTime()
        : 0;
    return [approvedRank, -updatedMs];
  };

  return [...candidates].sort((a, b) => {
    const [approvedA, updatedA] = rank(a);
    const [approvedB, updatedB] = rank(b);
    if (approvedA !== approvedB) return approvedA - approvedB;
    return updatedA - updatedB;
  })[0];
}

/** Pure evaluator â mirrors `get_driver_document_eligibility` classification. */
export function evaluateDriverDocumentStateFromSnapshot(args: {
  requiredSlugs?: string[];
  requiredRules?: RequiredDocumentRule[];
  documents: DocumentRowSnapshot[];
  now?: Date;
  serviceAreaId?: string | null;
  serviceAreaName?: string | null;
}): DriverDocumentEligibilityResult {
  const now = args.now ?? new Date();
  const requiredRules: RequiredDocumentRule[] = args.requiredRules
    ?? (args.requiredSlugs ?? []).map((slug) => ({ slug, expiry_required: true }));

  const missing_documents: string[] = [];
  const expired_documents: string[] = [];
  const rejected_documents: string[] = [];
  const resubmission_documents: string[] = [];
  const pending_documents: string[] = [];
  let approvedValidCount = 0;

  for (const rule of requiredRules) {
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

  const allRequiredApproved = requiredRules.length === 0
    || (
      approvedValidCount === requiredRules.length
      && missing_documents.length === 0
      && rejected_documents.length === 0
      && resubmission_documents.length === 0
      && expired_documents.length === 0
      && pending_documents.length === 0
    );

  let document_state: DriverDocumentState;
  let blocked_reasons: DriverBlockedReason[] = [];
  let message: string;

  const saLabel = args.serviceAreaName ?? "your assigned service area";
  let code: string | null = null;

  if (allRequiredApproved) {
    document_state = "documents_approved";
    message = "";
  } else if (rejected_documents.length > 0) {
    document_state = "documents_rejected";
    blocked_reasons = [DRIVER_BLOCKED_REASON.DOCUMENTS_REJECTED];
    code = DRIVER_BLOCKED_REASON.DOCUMENTS_REJECTED;
    message = `Rejected documents for ${saLabel}: ${rejected_documents.join(", ")}`;
  } else if (resubmission_documents.length > 0) {
    document_state = "documents_rejected";
    blocked_reasons = [DRIVER_BLOCKED_REASON.DOCUMENTS_REJECTED];
    code = DRIVER_BLOCKED_REASON.DOCUMENTS_REJECTED;
    message = `Documents require resubmission for ${saLabel}: ${resubmission_documents.join(", ")}`;
  } else if (expired_documents.length > 0) {
    document_state = "documents_expired";
    blocked_reasons = [DRIVER_BLOCKED_REASON.DOCUMENTS_EXPIRED];
    code = DRIVER_BLOCKED_REASON.DOCUMENTS_EXPIRED;
    message = `Expired documents for ${saLabel}: ${expired_documents.join(", ")}`;
  } else if (missing_documents.length > 0) {
    document_state = "documents_missing";
    blocked_reasons = [DRIVER_BLOCKED_REASON.DOCUMENTS_MISSING];
    code = DRIVER_BLOCKED_REASON.DOCUMENTS_MISSING;
    message = `Missing documents for ${saLabel}: ${missing_documents.join(", ")}`;
  } else if (pending_documents.length > 0) {
    document_state = "documents_pending_review";
    blocked_reasons = [DRIVER_BLOCKED_REASON.DOCUMENTS_PENDING_REVIEW];
    code = DRIVER_BLOCKED_REASON.DOCUMENTS_PENDING_REVIEW;
    message = `Documents pending review for ${saLabel}: ${pending_documents.join(", ")}`;
  } else {
    document_state = "documents_uploaded";
    blocked_reasons = [DRIVER_BLOCKED_REASON.DOCUMENTS_PENDING_REVIEW];
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
    code,
  };
}

export function hasRequiredDocuments(result: DriverDocumentEligibilityResult): boolean {
  return result.missing_documents.length === 0;
}

export function hasExpiredDocuments(result: DriverDocumentEligibilityResult): boolean {
  return result.expired_documents.length > 0;
}

export function hasRejectedDocuments(result: DriverDocumentEligibilityResult): boolean {
  return result.rejected_documents.length > 0;
}

export function areDocumentsApproved(result: DriverDocumentEligibilityResult): boolean {
  return result.document_state === "documents_approved";
}

export function assertDocumentsApproved(
  result: DriverDocumentEligibilityResult,
): { ok: true } | { ok: false; result: DriverDocumentEligibilityResult } {
  if (areDocumentsApproved(result)) return { ok: true };
  return { ok: false, result };
}

export function documentStateToBlockedReasons(
  result: DriverDocumentEligibilityResult,
): DriverBlockedReason[] {
  return result.blocked_reasons.length
    ? [...result.blocked_reasons]
    : [DRIVER_BLOCKED_REASON.DOCUMENTS_PENDING_REVIEW];
}

type AssignedServiceArea = {
  service_area_id: string | null;
  service_area_name: string | null;
};

async function loadAssignedServiceArea(
  service: SupabaseClient,
  driverId: string,
): Promise<AssignedServiceArea> {
  const { data } = await service
    .from("drivers")
    .select("service_area_id, service_areas(name)")
    .eq("id", driverId)
    .maybeSingle();

  const joined = data?.service_areas as { name?: string } | { name?: string }[] | null;
  const name = Array.isArray(joined) ? joined[0]?.name : joined?.name;
  return {
    service_area_id: (data?.service_area_id as string | null) ?? null,
    service_area_name: name ?? null,
  };
}

/**
 * Required docs for drivers.service_area_id only.
 * No global fallback. No union across driver_service_areas.
 */
async function loadRequiredDocumentRulesForAssignedServiceArea(
  service: SupabaseClient,
  serviceAreaId: string,
): Promise<{ rulesConfigured: boolean; requiredRules: RequiredDocumentRule[] }> {
  const { data: allRules } = await service
    .from("service_area_document_rules")
    .select("doc_type_id, mandatory, expiry_required, display_in_driver_app, is_active")
    .eq("service_area_id", serviceAreaId);

  // Configured = any rule rows exist (disabled rules mean not required).
  const rulesConfigured = (allRules ?? []).length > 0;
  if (!rulesConfigured) {
    return { rulesConfigured: false, requiredRules: [] };
  }

  const mandatoryRules = (allRules ?? []).filter(
    (r) =>
      r.is_active === true
      && r.mandatory === true
      && r.display_in_driver_app !== false,
  );
  if (mandatoryRules.length === 0) {
    return { rulesConfigured: true, requiredRules: [] };
  }

  const typeIds = mandatoryRules.map((r) => r.doc_type_id).filter(Boolean);
  const { data: types } = await service
    .from("document_types")
    .select("id, slug")
    .in("id", typeIds)
    .eq("is_active", true);

  const typeById = new Map((types ?? []).map((t) => [t.id as string, t.slug as string]));
  const requiredRules: RequiredDocumentRule[] = [];
  for (const rule of mandatoryRules) {
    const slug = typeById.get(rule.doc_type_id as string);
    if (!slug) continue;
    requiredRules.push({
      slug,
      expiry_required: rule.expiry_required !== false,
    });
  }

  return { rulesConfigured: true, requiredRules };
}

export async function evaluateDriverDocumentState(
  service: SupabaseClient,
  driverId: string,
): Promise<DriverDocumentEligibilityResult> {
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
      blocked_reasons: [DRIVER_BLOCKED_REASON.DRIVER_SERVICE_AREA_NOT_ASSIGNED],
      message: "Driver has no assigned service area. Assign a service area before going online.",
      service_area_id: null,
      service_area_name: null,
      code: DRIVER_BLOCKED_REASON.DRIVER_SERVICE_AREA_NOT_ASSIGNED,
    };
  }

  const { rulesConfigured, requiredRules } =
    await loadRequiredDocumentRulesForAssignedServiceArea(service, assigned.service_area_id);

  if (!rulesConfigured) {
    return {
      allowed: false,
      document_state: "documents_missing",
      missing_documents: [],
      expired_documents: [],
      rejected_documents: [],
      resubmission_documents: [],
      pending_documents: [],
      blocked_reasons: [DRIVER_BLOCKED_REASON.SERVICE_AREA_DOCUMENT_RULES_NOT_CONFIGURED],
      message: `Document rules are not configured for service area ${
        assigned.service_area_name ?? assigned.service_area_id
      }.`,
      service_area_id: assigned.service_area_id,
      service_area_name: assigned.service_area_name,
      code: DRIVER_BLOCKED_REASON.SERVICE_AREA_DOCUMENT_RULES_NOT_CONFIGURED,
    };
  }

  const { data: documents } = await service
    .from("documents")
    .select("document_type, status, expiry_date, rejection_reason, created_at, updated_at")
    .eq("driver_id", driverId);

  return evaluateDriverDocumentStateFromSnapshot({
    requiredRules,
    documents: documents ?? [],
    serviceAreaId: assigned.service_area_id,
    serviceAreaName: assigned.service_area_name,
  });
}
