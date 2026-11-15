/**
 * Scheduled journey compliance SSOT — future-horizon document eligibility.
 *
 * Reuses Europe/London end-of-expiry-day semantics from documentExpiryLondon.ts
 * and journey end from scheduledAdvanceWindowSSOT (same basis as capture coverage).
 *
 * A driver eligible *today* is not eligible for a scheduled booking whose
 * estimated completion falls on a London calendar day after a required
 * document's expiry day.
 */

import {
  getLondonCalendarDate,
  isDocumentExpiredLondon,
  parseExpiryCalendarDate,
} from "./documentExpiryLondon.ts";
import { computeRequiredCaptureCoverageUntilMs } from "./scheduledAdvanceWindowSSOT.ts";
import {
  evaluateDriverDocumentStateFromSnapshot,
  type DocumentRowSnapshot,
  type RequiredDocumentRule,
} from "./driverDocumentEligibility.ts";

/** Default duration when trips.estimated_duration_minutes is missing (matches SQL). */
export const SCHEDULED_JOURNEY_DEFAULT_DURATION_MINUTES = 30;

export type ScheduledJourneyComplianceCode =
  | "OK"
  | "ACCOUNT_INELIGIBLE"
  | "DOCUMENTS_NOT_APPROVED"
  | "DOCUMENTS_EXPIRE_BEFORE_JOURNEY_END"
  | "INVALID_SCHEDULED_AT"
  | "IN_PROGRESS_PROTECTED";

export type ScheduledJourneyComplianceResult = {
  allowed: boolean;
  code: ScheduledJourneyComplianceCode;
  message: string;
  journeyEndIso: string | null;
  asOfLondonDate: string | null;
  expiredDocumentSlugs: string[];
};

export type ScheduledAccountSnapshot = {
  approval_status?: string | null;
  driver_status?: string | null;
  deleted_at?: string | null;
};

/** Mirror of trip_schedule_estimated_end — pickup + duration, no capture margin. */
export function resolveScheduledJourneyEndIso(input: {
  scheduledAtIso: string;
  estimatedDurationMinutes?: number | null;
}): string | null {
  const pickupMs = Date.parse(String(input.scheduledAtIso ?? ""));
  if (!Number.isFinite(pickupMs)) return null;
  const duration = Number(input.estimatedDurationMinutes);
  const minutes =
    Number.isFinite(duration) && duration > 0
      ? Math.floor(duration)
      : SCHEDULED_JOURNEY_DEFAULT_DURATION_MINUTES;
  return new Date(pickupMs + minutes * 60_000).toISOString();
}

/**
 * Capture-coverage helper includes a safety margin — compliance uses journey end
 * only (no extra buffer) so we do not invent a second horizon.
 */
export function resolveScheduledJourneyEndMs(input: {
  scheduledAtIso: string;
  estimatedDurationMinutes?: number | null;
}): number | null {
  const iso = resolveScheduledJourneyEndIso(input);
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

export function evaluateScheduledAccountEligible(
  account: ScheduledAccountSnapshot | null | undefined,
): boolean {
  if (!account) return false;
  if (account.deleted_at) return false;
  const approval = String(account.approval_status ?? "").toLowerCase().trim();
  const status = String(account.driver_status ?? "").toLowerCase().trim();
  if (["suspended", "rejected", "declined", "disabled"].includes(approval)) {
    return false;
  }
  if (approval !== "approved") return false;
  if (
    ["deleted", "soft_deleted", "suspended", "disabled", "inactive", "blocked"]
      .includes(status)
  ) {
    return false;
  }
  return status === "active";
}

/**
 * Temporary offline (`is_online=false`) must NOT release confirmed bookings.
 * This helper is intentional — callers must not treat offline as ineligible.
 */
export function temporaryOfflineReleasesConfirmedBooking(): false {
  return false;
}

/**
 * Required docs that would be expired as of the London calendar date of `asOf`.
 * Uses the same `<` end-of-day rule as isDocumentExpiredLondon.
 */
export function findDocumentsExpiredAsOf(input: {
  documents: DocumentRowSnapshot[];
  requiredRules: RequiredDocumentRule[];
  asOf: Date;
}): string[] {
  const expired: string[] = [];
  const asOfLondon = getLondonCalendarDate(input.asOf);
  for (const rule of input.requiredRules.filter((r) => r.mandatory !== false)) {
    if (!rule.expiry_required) continue;
    const candidates = input.documents.filter((d) => d.document_type === rule.slug);
    if (candidates.length === 0) continue;
    // Prefer approved current-shaped rows (mirrors SQL ORDER BY approved first).
    const ranked = [...candidates].sort((a, b) => {
      const aOk = String(a.status ?? "").toLowerCase() === "approved" ? 0 : 1;
      const bOk = String(b.status ?? "").toLowerCase() === "approved" ? 0 : 1;
      if (aOk !== bOk) return aOk - bOk;
      const aMs = a.updated_at ? Date.parse(a.updated_at) : 0;
      const bMs = b.updated_at ? Date.parse(b.updated_at) : 0;
      return bMs - aMs;
    });
    const doc = ranked[0];
    if (!doc) continue;
    const status = String(doc.status ?? "").toLowerCase();
    if (status !== "approved") continue;
    if (doc.expiry_date == null || isDocumentExpiredLondon(doc.expiry_date, input.asOf)) {
      // Missing expiry when required also counts as expired for the horizon.
      if (doc.expiry_date == null) {
        expired.push(rule.slug);
        continue;
      }
      const expiryDay = parseExpiryCalendarDate(doc.expiry_date);
      if (expiryDay && expiryDay < asOfLondon) {
        expired.push(rule.slug);
      }
    }
  }
  return expired;
}

/**
 * Full scheduled-journey compliance: account + docs valid now + docs valid
 * through estimated journey end (London calendar).
 */
export function evaluateScheduledJourneyCompliance(input: {
  account: ScheduledAccountSnapshot | null | undefined;
  documents: DocumentRowSnapshot[];
  requiredRules: RequiredDocumentRule[];
  scheduledAtIso: string;
  estimatedDurationMinutes?: number | null;
  now?: Date;
  /** Active passenger journey statuses — never release via this helper. */
  tripStatus?: string | null;
}): ScheduledJourneyComplianceResult {
  // Only protect passenger-aboard / terminal — activated pre-start uses rematch paths.
  const status = String(input.tripStatus ?? "").toLowerCase();
  if (["in_progress", "completed", "cancelled"].includes(status)) {
    return {
      allowed: false,
      code: "IN_PROGRESS_PROTECTED",
      message: "Active passenger journey is protected from scheduled compliance release.",
      journeyEndIso: null,
      asOfLondonDate: null,
      expiredDocumentSlugs: [],
    };
  }

  if (!evaluateScheduledAccountEligible(input.account)) {
    return {
      allowed: false,
      code: "ACCOUNT_INELIGIBLE",
      message:
        "Driver account is not approved and active for scheduled bookings.",
      journeyEndIso: null,
      asOfLondonDate: null,
      expiredDocumentSlugs: [],
    };
  }

  const now = input.now ?? new Date();
  const live = evaluateDriverDocumentStateFromSnapshot({
    requiredRules: input.requiredRules,
    documents: input.documents,
    now,
  });
  if (!live.allowed) {
    return {
      allowed: false,
      code: "DOCUMENTS_NOT_APPROVED",
      message:
        live.message ||
        "One or more required documents is not approved or has expired.",
      journeyEndIso: null,
      asOfLondonDate: getLondonCalendarDate(now),
      expiredDocumentSlugs: live.expired_documents,
    };
  }

  const journeyEndIso = resolveScheduledJourneyEndIso({
    scheduledAtIso: input.scheduledAtIso,
    estimatedDurationMinutes: input.estimatedDurationMinutes,
  });
  if (!journeyEndIso) {
    return {
      allowed: false,
      code: "INVALID_SCHEDULED_AT",
      message: "Scheduled pickup time is invalid.",
      journeyEndIso: null,
      asOfLondonDate: null,
      expiredDocumentSlugs: [],
    };
  }

  const journeyEnd = new Date(journeyEndIso);
  const horizon = evaluateDriverDocumentStateFromSnapshot({
    requiredRules: input.requiredRules,
    documents: input.documents,
    now: journeyEnd,
  });
  const expiredSlugs = findDocumentsExpiredAsOf({
    documents: input.documents,
    requiredRules: input.requiredRules,
    asOf: journeyEnd,
  });

  if (!horizon.allowed || expiredSlugs.length > 0) {
    return {
      allowed: false,
      code: "DOCUMENTS_EXPIRE_BEFORE_JOURNEY_END",
      message:
        "Required documents do not remain valid through the scheduled journey.",
      journeyEndIso,
      asOfLondonDate: getLondonCalendarDate(journeyEnd),
      expiredDocumentSlugs: expiredSlugs.length
        ? expiredSlugs
        : horizon.expired_documents,
    };
  }

  return {
    allowed: true,
    code: "OK",
    message: "",
    journeyEndIso,
    asOfLondonDate: getLondonCalendarDate(journeyEnd),
    expiredDocumentSlugs: [],
  };
}

/**
 * Whether an unactivated confirmed scheduled booking should be released when
 * compliance fails. Temporary offline never triggers release.
 */
export function shouldReleaseConfirmedScheduledForCompliance(input: {
  compliance: ScheduledJourneyComplianceResult;
  isOnline?: boolean | null;
  tripStatus?: string | null;
  hasStartedAt?: boolean;
}): boolean {
  if (input.hasStartedAt) return false;
  const status = String(input.tripStatus ?? "").toLowerCase();
  if (
    ["in_progress", "en_route_to_pickup", "arrived", "arrived_at_pickup", "pickup_waiting", "completed", "cancelled"]
      .includes(status)
  ) {
    return false;
  }
  if (input.compliance.code === "IN_PROGRESS_PROTECTED") return false;
  // Offline is irrelevant — only compliance failure releases.
  void temporaryOfflineReleasesConfirmedBooking();
  return !input.compliance.allowed;
}

/** Driver-facing release copy (no private compliance detail). */
export const SCHEDULED_COMPLIANCE_RELEASE_DRIVER_MESSAGE =
  "Your scheduled trip has been released because your account or required documents no longer meet the eligibility requirements.";

/**
 * Inside urgent conversion window (minutes before pickup) → use existing
 * scheduled-to-instant rescue instead of marketplace reopen.
 */
export function shouldUseUrgentRescueForComplianceRelease(input: {
  scheduledAtIso: string;
  nowMs?: number;
  urgentTriggerMinutesBeforePickup?: number;
}): boolean {
  const pickupMs = Date.parse(String(input.scheduledAtIso ?? ""));
  if (!Number.isFinite(pickupMs)) return false;
  const nowMs = input.nowMs ?? Date.now();
  const trigger = Math.max(
    0,
    input.urgentTriggerMinutesBeforePickup ?? 9,
  );
  const minutesToPickup = (pickupMs - nowMs) / 60_000;
  return minutesToPickup <= trigger;
}

/** Sanity: capture coverage helper still available for payment (unchanged). */
export function captureCoverageHorizonMs(input: {
  scheduledAtIso: string;
  estimatedDurationMinutes?: number | null;
}): number | null {
  return computeRequiredCaptureCoverageUntilMs({
    scheduledAtIso: input.scheduledAtIso,
    estimatedDurationMinutes: input.estimatedDurationMinutes,
  });
}
