/**
 * Canonical driver document compliance — Europe/London calendar expiry SSOT.
 * Used by driver app, admin review, banners, and online/offer gates (client preflight).
 */
import {
  getLondonCalendarDate,
  isDocumentExpiredLondon,
  isDocumentExpiringSoonLondon,
  parseExpiryCalendarDate,
} from "./documentExpiryLondon";

export type DocumentComplianceIssueKind =
  | "missing"
  | "pending"
  | "rejected"
  | "declined"
  | "resubmission_required"
  | "expired"
  | "expiring_soon";

export type DocumentComplianceIssue = {
  slug: string;
  name: string;
  issue: DocumentComplianceIssueKind;
  expiryDate?: string;
  status?: string | null;
};

export type DriverDocumentComplianceStatus =
  | "compliant"
  | "expired"
  | "rejected"
  | "missing"
  | "pending"
  | "expiring_soon";

export type RequiredDocumentType = {
  slug: string;
  name: string;
  has_expiry: boolean;
};

export type DocumentRowSnapshot = {
  document_type: string;
  status?: string | null;
  expiry_date?: string | null;
};

const PENDING_STATUSES = new Set(["pending", "uploaded", "submitted"]);
const REJECTED_STATUSES = new Set(["rejected", "declined"]);
const RESUBMISSION_STATUSES = new Set([
  "resubmission_required",
  "resubmit_required",
  "requires_resubmission",
]);

export const COMPLIANCE_BLOCKING_ISSUES = new Set<DocumentComplianceIssueKind>([
  "missing",
  "pending",
  "rejected",
  "declined",
  "resubmission_required",
  "expired",
]);

/** Alias for SSOT naming in audits. */
export function isDocumentExpired(
  expiryDate: string | null | undefined,
  now: Date = new Date(),
): boolean {
  return isDocumentExpiredLondon(expiryDate, now);
}

export function isDocumentExpiringSoon(
  expiryDate: string | null | undefined,
  warningDays: number,
  now: Date = new Date(),
): boolean {
  return isDocumentExpiringSoonLondon(expiryDate, warningDays, now);
}

function normalizeStatus(status: string | null | undefined): string {
  return String(status ?? "").toLowerCase().trim();
}

function classifyDocumentRow(args: {
  slug: string;
  name: string;
  doc: DocumentRowSnapshot | undefined;
  hasExpiry: boolean;
  warningDays: number;
  now: Date;
}): DocumentComplianceIssue | null {
  const { slug, name, doc, hasExpiry, warningDays, now } = args;
  if (!doc) {
    return { slug, name, issue: "missing" };
  }

  const status = normalizeStatus(doc.status);

  if (REJECTED_STATUSES.has(status)) {
    return {
      slug,
      name,
      issue: status === "declined" ? "declined" : "rejected",
      status: doc.status,
      expiryDate: doc.expiry_date ?? undefined,
    };
  }

  if (RESUBMISSION_STATUSES.has(status)) {
    return {
      slug,
      name,
      issue: "resubmission_required",
      status: doc.status,
      expiryDate: doc.expiry_date ?? undefined,
    };
  }

  if (PENDING_STATUSES.has(status)) {
    return {
      slug,
      name,
      issue: "pending",
      status: doc.status,
      expiryDate: doc.expiry_date ?? undefined,
    };
  }

  if (hasExpiry && doc.expiry_date && isDocumentExpired(doc.expiry_date, now)) {
    return {
      slug,
      name,
      issue: "expired",
      status: doc.status,
      expiryDate: doc.expiry_date,
    };
  }

  if (
    status === "approved"
    && hasExpiry
    && doc.expiry_date
    && isDocumentExpiringSoon(doc.expiry_date, warningDays, now)
  ) {
    return {
      slug,
      name,
      issue: "expiring_soon",
      status: doc.status,
      expiryDate: doc.expiry_date,
    };
  }

  if (status === "approved") {
    return null;
  }

  return {
    slug,
    name,
    issue: "pending",
    status: doc.status,
    expiryDate: doc.expiry_date ?? undefined,
  };
}

export function getDriverDocumentComplianceStatus(args: {
  requiredTypes: RequiredDocumentType[];
  documents: DocumentRowSnapshot[];
  warningDays?: number;
  now?: Date;
}): {
  status: DriverDocumentComplianceStatus;
  issues: DocumentComplianceIssue[];
  expiredCount: number;
  expiringSoonCount: number;
  rejectedCount: number;
  pendingCount: number;
  missingCount: number;
  approvedValidCount: number;
  canGoOnline: boolean;
  canReceiveOffers: boolean;
  canAcceptOffer: boolean;
  bannerMessage: string | null;
  documentsApproved: boolean;
} {
  const now = args.now ?? new Date();
  const warningDays = args.warningDays ?? 7;
  const docsBySlug = new Map(args.documents.map((d) => [d.document_type, d]));
  const issues: DocumentComplianceIssue[] = [];

  for (const dt of args.requiredTypes) {
    const issue = classifyDocumentRow({
      slug: dt.slug,
      name: dt.name,
      doc: docsBySlug.get(dt.slug),
      hasExpiry: dt.has_expiry,
      warningDays,
      now,
    });
    if (issue) issues.push(issue);
  }

  const expiredCount = issues.filter((i) => i.issue === "expired").length;
  const expiringSoonCount = issues.filter((i) => i.issue === "expiring_soon").length;
  const rejectedCount = issues.filter((i) =>
    i.issue === "rejected" || i.issue === "declined" || i.issue === "resubmission_required"
  ).length;
  const pendingCount = issues.filter((i) => i.issue === "pending").length;
  const missingCount = issues.filter((i) => i.issue === "missing").length;
  const blockingCount = issues.filter((i) => COMPLIANCE_BLOCKING_ISSUES.has(i.issue)).length;
  const approvedValidCount = args.requiredTypes.length - blockingCount;

  const hasBlocking = blockingCount > 0;
  const canGoOnline = !hasBlocking && (args.requiredTypes.length === 0 || approvedValidCount >= args.requiredTypes.length);

  let status: DriverDocumentComplianceStatus = "compliant";
  if (expiredCount > 0) status = "expired";
  else if (rejectedCount > 0) status = "rejected";
  else if (missingCount > 0) status = "missing";
  else if (pendingCount > 0) status = "pending";
  else if (expiringSoonCount > 0) status = "expiring_soon";

  const bannerMessage = expiredCount > 0
    ? "Documents expired — upload renewal"
    : expiringSoonCount > 0 && !hasBlocking
      ? `${expiringSoonCount} document${expiringSoonCount > 1 ? "s" : ""} expiring soon`
      : hasBlocking
        ? "Documents need attention — open My Documents"
        : null;

  return {
    status,
    issues,
    expiredCount,
    expiringSoonCount,
    rejectedCount,
    pendingCount,
    missingCount,
    approvedValidCount,
    canGoOnline,
    canReceiveOffers: canGoOnline,
    canAcceptOffer: canGoOnline,
    bannerMessage,
    documentsApproved: canGoOnline,
  };
}

export function canDriverGoOnline(compliance: ReturnType<typeof getDriverDocumentComplianceStatus>): boolean {
  return compliance.canGoOnline;
}

export function canDriverReceiveOffers(compliance: ReturnType<typeof getDriverDocumentComplianceStatus>): boolean {
  return compliance.canReceiveOffers;
}

export function canDriverAcceptOffer(compliance: ReturnType<typeof getDriverDocumentComplianceStatus>): boolean {
  return compliance.canAcceptOffer;
}

/** Admin / list UI — computed expiry label for an approved doc row. */
export function getDocumentExpiryDisplayStatus(args: {
  status: string | null | undefined;
  expiry_date: string | null | undefined;
  has_expiry: boolean;
  warningDays?: number;
  now?: Date;
}): "valid" | "expired" | "expiring_soon" | "n/a" {
  if (!args.has_expiry || !args.expiry_date) return "n/a";
  const status = normalizeStatus(args.status);
  if (status !== "approved" && status !== "pending" && status !== "uploaded") return "n/a";
  if (isDocumentExpired(args.expiry_date, args.now)) return "expired";
  if (isDocumentExpiringSoon(args.expiry_date, args.warningDays ?? 7, args.now)) {
    return "expiring_soon";
  }
  return "valid";
}

/** Format expiry date for display without UTC drift (YYYY-MM-DD → d MMM yyyy). */
export function formatExpiryDisplayDate(expiryDate: string): string {
  const day = parseExpiryCalendarDate(expiryDate);
  if (!day) return expiryDate;
  const [y, m, d] = day.split("-").map(Number);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${d} ${months[m - 1]} ${y}`;
}

export { getLondonCalendarDate };
