import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import {
  evaluateDriverOnboardingLogin,
  ONBOARDING_LOGIN_BLOCK,
  type OnboardingLoginBlockCode,
} from "./onboardingLoginGuard.ts";
import {
  documentStateToBlockedReasons,
  evaluateDriverDocumentState,
  type DriverDocumentEligibilityResult,
} from "./driverDocumentEligibility.ts";

/** Canonical driver auth states (Phase 4F.2). */
export type DriverAuthState =
  | "unauthenticated"
  | "email_unverified"
  | "phone_unverified"
  | "documents_missing"
  | "documents_pending_review"
  | "approved_offline"
  | "approved_online"
  | "suspended"
  | "rejected";

export const DRIVER_BLOCKED_REASON = {
  AUTH_REQUIRED: "AUTH_REQUIRED",
  EMAIL_UNVERIFIED: "EMAIL_UNVERIFIED",
  PHONE_UNVERIFIED: "PHONE_UNVERIFIED",
  DRIVER_PROFILE_MISSING: "DRIVER_PROFILE_MISSING",
  DOCUMENTS_MISSING: "DOCUMENTS_MISSING",
  DOCUMENTS_PENDING_REVIEW: "DOCUMENTS_PENDING_REVIEW",
  DOCUMENTS_REJECTED: "DOCUMENTS_REJECTED",
  DOCUMENTS_EXPIRED: "DOCUMENTS_EXPIRED",
  DRIVER_SERVICE_AREA_NOT_ASSIGNED: "DRIVER_SERVICE_AREA_NOT_ASSIGNED",
  SERVICE_AREA_DOCUMENT_RULES_NOT_CONFIGURED: "SERVICE_AREA_DOCUMENT_RULES_NOT_CONFIGURED",
  DRIVER_NOT_APPROVED: "DRIVER_NOT_APPROVED",
  DRIVER_SUSPENDED: "DRIVER_SUSPENDED",
  DRIVER_REJECTED: "DRIVER_REJECTED",
  DRIVER_OFFLINE: "DRIVER_OFFLINE",
  ACCOUNT_INACTIVE: "ACCOUNT_INACTIVE",
} as const;

export type DriverBlockedReason =
  typeof DRIVER_BLOCKED_REASON[keyof typeof DRIVER_BLOCKED_REASON];

export type DriverEligibilityResult = {
  allowed: boolean;
  state: DriverAuthState;
  blocked_reasons: DriverBlockedReason[];
  message: string;
  driver_id?: string | null;
};

export const DEFAULT_DRIVER_OFFER_BLOCKED_MESSAGE =
  "Complete verification and approval before receiving trips.";

type DriverRowSnapshot = {
  id: string;
  user_id?: string;
  approval_status?: string | null;
  driver_status?: string | null;
  documents_approved?: boolean | null;
  is_online?: boolean | null;
  email_verified?: boolean | null;
  phone_verified?: boolean | null;
};

export function unauthenticatedDriverEligibility(
  message = "Sign in required.",
): DriverEligibilityResult {
  return {
    allowed: false,
    state: "unauthenticated",
    blocked_reasons: [DRIVER_BLOCKED_REASON.AUTH_REQUIRED],
    message,
    driver_id: null,
  };
}

export function blockCodeToDriverBlockedReasons(
  blockCode: OnboardingLoginBlockCode | null,
): DriverBlockedReason[] {
  switch (blockCode) {
    case ONBOARDING_LOGIN_BLOCK.EMAIL_NOT_VERIFIED:
      return [DRIVER_BLOCKED_REASON.EMAIL_UNVERIFIED];
    case ONBOARDING_LOGIN_BLOCK.PHONE_NOT_VERIFIED:
      return [DRIVER_BLOCKED_REASON.PHONE_UNVERIFIED];
    case ONBOARDING_LOGIN_BLOCK.NO_PROFILE:
      return [DRIVER_BLOCKED_REASON.DRIVER_PROFILE_MISSING];
    case ONBOARDING_LOGIN_BLOCK.DRIVER_NOT_APPROVED:
      return [DRIVER_BLOCKED_REASON.DRIVER_NOT_APPROVED];
    case ONBOARDING_LOGIN_BLOCK.DOCUMENTS_NOT_APPROVED:
      return [DRIVER_BLOCKED_REASON.DOCUMENTS_PENDING_REVIEW];
    case ONBOARDING_LOGIN_BLOCK.DOCUMENTS_EXPIRED:
      return [DRIVER_BLOCKED_REASON.DOCUMENTS_EXPIRED];
    case ONBOARDING_LOGIN_BLOCK.ACCOUNT_NOT_ACTIVE:
      return [DRIVER_BLOCKED_REASON.ACCOUNT_INACTIVE];
    default:
      return [DRIVER_BLOCKED_REASON.DRIVER_NOT_APPROVED];
  }
}

/** Map guard + driver snapshot â auth state (unit-testable). */
export function mapDriverGuardToState(
  guard: Awaited<ReturnType<typeof evaluateDriverOnboardingLogin>>,
  driver: DriverRowSnapshot | null,
  documentReasons: DriverBlockedReason[] = [],
): Pick<DriverEligibilityResult, "state" | "blocked_reasons" | "message"> {
  if (guard.app_access_allowed && driver) {
    const approval = String(driver.approval_status ?? "").toLowerCase();
    if (approval === "rejected") {
      return {
        state: "rejected",
        blocked_reasons: [DRIVER_BLOCKED_REASON.DRIVER_REJECTED],
        message: "Your driver application was not approved.",
      };
    }
    if (approval === "suspended") {
      return {
        state: "suspended",
        blocked_reasons: [DRIVER_BLOCKED_REASON.DRIVER_SUSPENDED],
        message: "Your driver account is suspended.",
      };
    }
    if (String(driver.driver_status ?? "").toLowerCase() !== "active") {
      return {
        state: "suspended",
        blocked_reasons: [DRIVER_BLOCKED_REASON.ACCOUNT_INACTIVE],
        message: "Your driver account is not active.",
      };
    }
    const online = driver.is_online === true;
    return {
      state: online ? "approved_online" : "approved_offline",
      blocked_reasons: documentReasons,
      message: "",
    };
  }

  const blocked_reasons = [
    ...blockCodeToDriverBlockedReasons(guard.block_code),
    ...documentReasons.filter((r) => !blockCodeToDriverBlockedReasons(guard.block_code).includes(r)),
  ];

  if (guard.block_code === ONBOARDING_LOGIN_BLOCK.EMAIL_NOT_VERIFIED) {
    return {
      state: "email_unverified",
      blocked_reasons,
      message: guard.message ?? "Please verify your email address before going online.",
    };
  }

  if (guard.block_code === ONBOARDING_LOGIN_BLOCK.PHONE_NOT_VERIFIED) {
    return {
      state: "phone_unverified",
      blocked_reasons,
      message: guard.message ?? "Please verify your phone number before going online.",
    };
  }

  if (guard.block_code === ONBOARDING_LOGIN_BLOCK.NO_PROFILE) {
    return {
      state: "phone_unverified",
      blocked_reasons,
      message: guard.message ?? DEFAULT_DRIVER_OFFER_BLOCKED_MESSAGE,
    };
  }

  const approval = String(driver?.approval_status ?? "").toLowerCase();
  if (approval === "rejected") {
    return {
      state: "rejected",
      blocked_reasons: [DRIVER_BLOCKED_REASON.DRIVER_REJECTED],
      message: guard.message ?? "Your driver application was not approved.",
    };
  }
  if (approval === "suspended") {
    return {
      state: "suspended",
      blocked_reasons: [DRIVER_BLOCKED_REASON.DRIVER_SUSPENDED],
      message: guard.message ?? "Your driver account is suspended.",
    };
  }

  if (guard.block_code === ONBOARDING_LOGIN_BLOCK.DOCUMENTS_NOT_APPROVED) {
    const state = documentReasons.includes(DRIVER_BLOCKED_REASON.DOCUMENTS_MISSING)
      ? "documents_missing"
      : "documents_pending_review";
    return {
      state,
      blocked_reasons: blocked_reasons.length ? blocked_reasons : [DRIVER_BLOCKED_REASON.DOCUMENTS_PENDING_REVIEW],
      message: guard.message ?? "Your documents are not approved yet.",
    };
  }

  if (guard.block_code === ONBOARDING_LOGIN_BLOCK.DRIVER_NOT_APPROVED) {
    return {
      state: documentReasons.includes(DRIVER_BLOCKED_REASON.DOCUMENTS_MISSING)
        ? "documents_missing"
        : "documents_pending_review",
      blocked_reasons,
      message: guard.message ?? (documentReasons.length === 0
        ? "Your driver profile is pending admin approval."
        : "Complete document upload and approval before going online."),
    };
  }

  return {
    state: "documents_pending_review",
    blocked_reasons,
    message: guard.message ?? DEFAULT_DRIVER_OFFER_BLOCKED_MESSAGE,
  };
}

async function resolveDocumentBlockedReasons(
  service: SupabaseClient,
  driverId: string,
): Promise<{ reasons: DriverBlockedReason[]; docState: DriverDocumentEligibilityResult }> {
  const docState = await evaluateDriverDocumentState(service, driverId);
  return {
    reasons: documentStateToBlockedReasons(docState),
    docState,
  };
}

async function loadDriverByUserId(
  service: SupabaseClient,
  userId: string,
): Promise<DriverRowSnapshot | null> {
  const { data } = await service
    .from("drivers")
    .select("id, user_id, approval_status, driver_status, documents_approved, is_online, email_verified, phone_verified")
    .eq("user_id", userId)
    .is("deleted_at", null)
    .maybeSingle();
  return data ?? null;
}

async function loadDriverById(
  service: SupabaseClient,
  driverId: string,
): Promise<DriverRowSnapshot | null> {
  const { data } = await service
    .from("drivers")
    .select("id, user_id, approval_status, driver_status, documents_approved, is_online, email_verified, phone_verified")
    .eq("id", driverId)
    .is("deleted_at", null)
    .maybeSingle();
  return data ?? null;
}

export async function evaluateDriverAuthState(
  service: SupabaseClient,
  userId: string | null | undefined,
): Promise<DriverEligibilityResult> {
  if (!userId) return unauthenticatedDriverEligibility();

  const guard = await evaluateDriverOnboardingLogin(service, userId);
  const driver = await loadDriverByUserId(service, userId);

  let documentReasons: DriverBlockedReason[] = [];
  let documentState: DriverDocumentEligibilityResult | null = null;

  if (driver) {
    const resolved = await resolveDocumentBlockedReasons(service, driver.id);
    documentState = resolved.docState;
    if (!documentState.allowed) {
      documentReasons = resolved.reasons;
    }
  }

  const mapped = mapDriverGuardToState(guard, driver, documentReasons);
  const docMessage = documentState?.message;
  const docAllowed = documentState?.allowed !== false;
  const allowed = guard.app_access_allowed
    && mapped.state !== "suspended"
    && mapped.state !== "rejected"
    && docAllowed;

  return {
    allowed,
    ...mapped,
    message: docMessage || mapped.message || DEFAULT_DRIVER_OFFER_BLOCKED_MESSAGE,
    driver_id: driver?.id ?? null,
  };
}

export async function evaluateDriverEligibilityByDriverId(
  service: SupabaseClient,
  driverId: string | null | undefined,
): Promise<DriverEligibilityResult> {
  if (!driverId) {
    return {
      ...unauthenticatedDriverEligibility("Driver profile required."),
      blocked_reasons: [DRIVER_BLOCKED_REASON.DRIVER_PROFILE_MISSING],
    };
  }

  const driver = await loadDriverById(service, driverId);
  if (!driver?.user_id) {
    return {
      allowed: false,
      state: "documents_missing",
      blocked_reasons: [DRIVER_BLOCKED_REASON.DRIVER_PROFILE_MISSING],
      message: DEFAULT_DRIVER_OFFER_BLOCKED_MESSAGE,
      driver_id: driverId,
    };
  }

  const result = await evaluateDriverAuthState(service, driver.user_id);
  return { ...result, driver_id: driverId };
}

function withOfflineBlock(
  result: DriverEligibilityResult,
  requireOnline: boolean,
): DriverEligibilityResult {
  if (!requireOnline || result.state === "approved_online") return result;
  if (result.state === "approved_offline") {
    return {
      allowed: false,
      state: result.state,
      blocked_reasons: [...result.blocked_reasons, DRIVER_BLOCKED_REASON.DRIVER_OFFLINE],
      message: "Go online to receive ride offers.",
      driver_id: result.driver_id,
    };
  }
  return result;
}

/** Approved + docs + not suspended/rejected â may still be offline. */
export async function canGoOnline(
  service: SupabaseClient,
  userId: string | null | undefined,
): Promise<DriverEligibilityResult> {
  const base = await evaluateDriverAuthState(service, userId);
  const allowed = base.allowed
    && (base.state === "approved_offline" || base.state === "approved_online");
  return {
    ...base,
    allowed,
    message: allowed ? "" : base.message || DEFAULT_DRIVER_OFFER_BLOCKED_MESSAGE,
  };
}

export async function assertCanGoOnline(
  service: SupabaseClient,
  userId: string | null | undefined,
): Promise<DriverEligibilityResult> {
  return canGoOnline(service, userId);
}

/** Must be approved_online (online flag set). */
export async function canReceiveOffers(
  service: SupabaseClient,
  userId: string | null | undefined,
): Promise<DriverEligibilityResult> {
  const base = await evaluateDriverAuthState(service, userId);
  const onlineResult = withOfflineBlock(base, true);
  const allowed = onlineResult.allowed && onlineResult.state === "approved_online";
  return {
    ...onlineResult,
    allowed,
    message: allowed ? "" : onlineResult.message || DEFAULT_DRIVER_OFFER_BLOCKED_MESSAGE,
  };
}

export async function canReceiveOffersByDriverId(
  service: SupabaseClient,
  driverId: string | null | undefined,
): Promise<DriverEligibilityResult> {
  const base = await evaluateDriverEligibilityByDriverId(service, driverId);
  const onlineResult = withOfflineBlock(base, true);
  const allowed = onlineResult.allowed && onlineResult.state === "approved_online";
  return {
    ...onlineResult,
    allowed,
    message: allowed ? "" : onlineResult.message || DEFAULT_DRIVER_OFFER_BLOCKED_MESSAGE,
  };
}

export async function assertCanReceiveOffers(
  service: SupabaseClient,
  userId: string | null | undefined,
): Promise<DriverEligibilityResult> {
  return canReceiveOffers(service, userId);
}

export async function canAcceptOffer(
  service: SupabaseClient,
  userId: string | null | undefined,
): Promise<DriverEligibilityResult> {
  return canReceiveOffers(service, userId);
}

export async function canAcceptOfferByDriverId(
  service: SupabaseClient,
  driverId: string | null | undefined,
): Promise<DriverEligibilityResult> {
  return canReceiveOffersByDriverId(service, driverId);
}

export async function assertCanAcceptOffer(
  service: SupabaseClient,
  userId: string | null | undefined,
): Promise<DriverEligibilityResult> {
  return canAcceptOffer(service, userId);
}

export async function assertCanAcceptOfferByDriverId(
  service: SupabaseClient,
  driverId: string | null | undefined,
): Promise<DriverEligibilityResult> {
  return canAcceptOfferByDriverId(service, driverId);
}

/** In-trip completion â allow approved drivers with active trip even if offer gates would block new offers. */
export async function canCompleteTrip(
  service: SupabaseClient,
  userId: string | null | undefined,
): Promise<DriverEligibilityResult> {
  const base = await evaluateDriverAuthState(service, userId);
  const allowed = base.state === "approved_online"
    || base.state === "approved_offline"
    || (base.state === "suspended" && base.driver_id != null);
  return {
    ...base,
    allowed,
    message: allowed ? "" : base.message || DEFAULT_DRIVER_OFFER_BLOCKED_MESSAGE,
  };
}

export type DriverNotEligibleBody = {
  error: "DRIVER_NOT_ELIGIBLE";
  blocked_reasons: DriverBlockedReason[];
  auth_state: DriverAuthState;
  message: string;
};

export function buildDriverNotEligibleBody(
  result: DriverEligibilityResult,
): DriverNotEligibleBody {
  return {
    error: "DRIVER_NOT_ELIGIBLE",
    blocked_reasons: result.blocked_reasons,
    auth_state: result.state,
    message: result.message || DEFAULT_DRIVER_OFFER_BLOCKED_MESSAGE,
  };
}

export function driverNotEligibleResponse(
  result: DriverEligibilityResult,
  corsHeaders: Record<string, string>,
  status = 403,
): Response {
  return new Response(JSON.stringify(buildDriverNotEligibleBody(result)), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

export function logDriverEligibilityBlocked(
  edge: string,
  driverId: string | null | undefined,
  result: DriverEligibilityResult,
): void {
  console.info("DRIVER_ELIGIBILITY_BLOCKED", JSON.stringify({
    edge,
    driver_id: driverId ?? null,
    auth_state: result.state,
    blocked_reasons: result.blocked_reasons,
  }));
}

/** Dispatch snapshot â mirrors auto-dispatch hard gates (excludes presence/location). */
export function driverSnapshotBlocksReceiveOffers(
  driver: {
    approval_status?: string | null;
    driver_status?: string | null;
    documents_approved?: boolean | null;
    is_online?: boolean | null;
  },
): DriverBlockedReason[] {
  const reasons: DriverBlockedReason[] = [];
  if (String(driver.driver_status ?? "").toLowerCase() !== "active") {
    reasons.push(DRIVER_BLOCKED_REASON.ACCOUNT_INACTIVE);
  }
  const approval = String(driver.approval_status ?? "").toLowerCase();
  if (approval === "suspended") reasons.push(DRIVER_BLOCKED_REASON.DRIVER_SUSPENDED);
  if (approval === "rejected") reasons.push(DRIVER_BLOCKED_REASON.DRIVER_REJECTED);
  if (approval !== "approved") reasons.push(DRIVER_BLOCKED_REASON.DRIVER_NOT_APPROVED);
  if (driver.documents_approved !== true) reasons.push(DRIVER_BLOCKED_REASON.DOCUMENTS_PENDING_REVIEW);
  if (driver.is_online !== true) reasons.push(DRIVER_BLOCKED_REASON.DRIVER_OFFLINE);
  return reasons;
}
