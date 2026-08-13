import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import {
  evaluateCustomerOnboardingLogin,
  type OnboardingLoginBlockCode,
  ONBOARDING_LOGIN_BLOCK,
} from "./onboardingLoginGuard.ts";

/** Canonical passenger auth states (Phase 4F.2). */
export type PassengerAuthState =
  | "unauthenticated"
  | "email_unverified"
  | "phone_unverified"
  | "verified"
  | "suspended";

export const PASSENGER_BLOCKED_REASON = {
  AUTH_REQUIRED: "AUTH_REQUIRED",
  EMAIL_UNVERIFIED: "EMAIL_UNVERIFIED",
  PHONE_UNVERIFIED: "PHONE_UNVERIFIED",
  CUSTOMER_PROFILE_MISSING: "CUSTOMER_PROFILE_MISSING",
  CUSTOMER_SUSPENDED: "CUSTOMER_SUSPENDED",
  ONBOARDING_INCOMPLETE: "ONBOARDING_INCOMPLETE",
} as const;

export type PassengerBlockedReason =
  typeof PASSENGER_BLOCKED_REASON[keyof typeof PASSENGER_BLOCKED_REASON];

export type PassengerEligibilityResult = {
  allowed: boolean;
  state: PassengerAuthState;
  blocked_reasons: PassengerBlockedReason[];
  message: string;
};

const BLOCKED_RIDER_STATUSES = new Set(["disabled", "suspended", "banned", "blocked"]);

export const DEFAULT_BOOKING_BLOCKED_MESSAGE =
  "Please verify your email and phone number before booking.";

/** Map onboarding guard output → auth state + blocked reasons (unit-testable). */
export function mapOnboardingGuardToPassengerState(
  guard: Awaited<ReturnType<typeof evaluateCustomerOnboardingLogin>>,
): Pick<PassengerEligibilityResult, "state" | "blocked_reasons" | "message"> {
  if (guard.app_access_allowed) {
    return { state: "verified", blocked_reasons: [], message: "" };
  }

  const blockCode = guard.block_code;
  const blocked_reasons: PassengerBlockedReason[] = [];

  if (blockCode === ONBOARDING_LOGIN_BLOCK.EMAIL_NOT_VERIFIED) {
    blocked_reasons.push(PASSENGER_BLOCKED_REASON.EMAIL_UNVERIFIED);
    return {
      state: "email_unverified",
      blocked_reasons,
      message: guard.message ?? "Please verify your email address before booking.",
    };
  }

  if (blockCode === ONBOARDING_LOGIN_BLOCK.PHONE_NOT_VERIFIED) {
    blocked_reasons.push(PASSENGER_BLOCKED_REASON.PHONE_UNVERIFIED);
    return {
      state: "phone_unverified",
      blocked_reasons,
      message: guard.message ?? "Please verify your phone number before booking.",
    };
  }

  if (blockCode === ONBOARDING_LOGIN_BLOCK.NO_PROFILE) {
    blocked_reasons.push(PASSENGER_BLOCKED_REASON.CUSTOMER_PROFILE_MISSING);
    blocked_reasons.push(PASSENGER_BLOCKED_REASON.ONBOARDING_INCOMPLETE);
    return {
      state: "phone_unverified",
      blocked_reasons,
      message: guard.message ?? DEFAULT_BOOKING_BLOCKED_MESSAGE,
    };
  }

  if (blockCode === ONBOARDING_LOGIN_BLOCK.ACCOUNT_NOT_ACTIVE) {
    blocked_reasons.push(PASSENGER_BLOCKED_REASON.ONBOARDING_INCOMPLETE);
    return {
      state: "phone_unverified",
      blocked_reasons,
      message: guard.message ?? "Your account is not active yet. Please complete verification.",
    };
  }

  blocked_reasons.push(PASSENGER_BLOCKED_REASON.ONBOARDING_INCOMPLETE);
  return {
    state: "phone_unverified",
    blocked_reasons,
    message: guard.message ?? DEFAULT_BOOKING_BLOCKED_MESSAGE,
  };
}

export function mapSuspensionToPassengerState(
  suspensionMessage: string | null,
): Pick<PassengerEligibilityResult, "state" | "blocked_reasons" | "message"> {
  return {
    state: "suspended",
    blocked_reasons: [PASSENGER_BLOCKED_REASON.CUSTOMER_SUSPENDED],
    message: suspensionMessage ?? "Your account has been suspended. Please contact support.",
  };
}

async function loadActiveCustomerSuspension(
  service: SupabaseClient,
  userId: string,
): Promise<{ suspended: boolean; message: string | null }> {
  const { data: suspension } = await service
    .from("account_suspensions")
    .select("id, reason, status, expires_at")
    .eq("user_id", userId)
    .eq("user_type", "customer")
    .eq("status", "active")
    .order("suspended_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (suspension && !(suspension.expires_at && new Date(suspension.expires_at) < new Date())) {
    return {
      suspended: true,
      message: suspension.reason || "Your account has been suspended. Please contact support.",
    };
  }

  const { data: customer } = await service
    .from("customers")
    .select("rider_status")
    .eq("user_id", userId)
    .is("deleted_at", null)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const status = String(customer?.rider_status ?? "").toLowerCase();
  if (BLOCKED_RIDER_STATUSES.has(status)) {
    return {
      suspended: true,
      message: `Your account is ${status}. Please contact support.`,
    };
  }

  return { suspended: false, message: null };
}

export function unauthenticatedPassengerEligibility(
  message = "Sign in required to book a ride.",
): PassengerEligibilityResult {
  return {
    allowed: false,
    state: "unauthenticated",
    blocked_reasons: [PASSENGER_BLOCKED_REASON.AUTH_REQUIRED],
    message,
  };
}

/** Resolve canonical passenger auth state (server SSOT). */
export async function evaluatePassengerAuthState(
  service: SupabaseClient,
  userId: string | null | undefined,
): Promise<PassengerEligibilityResult> {
  if (!userId) {
    return unauthenticatedPassengerEligibility();
  }

  const guard = await evaluateCustomerOnboardingLogin(service, userId);
  if (!guard.app_access_allowed) {
    const mapped = mapOnboardingGuardToPassengerState(guard);
    return {
      allowed: false,
      ...mapped,
      message: mapped.message || DEFAULT_BOOKING_BLOCKED_MESSAGE,
    };
  }

  const suspension = await loadActiveCustomerSuspension(service, userId);
  if (suspension.suspended) {
    const mapped = mapSuspensionToPassengerState(suspension.message);
    return { allowed: false, ...mapped };
  }

  return {
    allowed: true,
    state: "verified",
    blocked_reasons: [],
    message: "",
  };
}

/** Returns true only when passenger may create or pay for a trip. */
export async function canBookRide(
  service: SupabaseClient,
  userId: string | null | undefined,
): Promise<PassengerEligibilityResult> {
  return evaluatePassengerAuthState(service, userId);
}

/** Same as canBookRide — explicit assert naming for edge handlers. */
export async function assertCanBookRide(
  service: SupabaseClient,
  userId: string | null | undefined,
): Promise<PassengerEligibilityResult> {
  return canBookRide(service, userId);
}

export type PassengerNotEligibleBody = {
  error: "PASSENGER_NOT_ELIGIBLE";
  blocked_reasons: PassengerBlockedReason[];
  auth_state: PassengerAuthState;
  message: string;
};

export function buildPassengerNotEligibleBody(
  result: PassengerEligibilityResult,
): PassengerNotEligibleBody {
  return {
    error: "PASSENGER_NOT_ELIGIBLE",
    blocked_reasons: result.blocked_reasons,
    auth_state: result.state,
    message: result.message || DEFAULT_BOOKING_BLOCKED_MESSAGE,
  };
}

export function passengerNotEligibleResponse(
  result: PassengerEligibilityResult,
  corsHeaders: Record<string, string>,
  status = 403,
): Response {
  return new Response(JSON.stringify(buildPassengerNotEligibleBody(result)), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/** Log safe audit line when booking is blocked (no PII). */
export function logPassengerBookingBlocked(
  edge: string,
  userId: string | null | undefined,
  result: PassengerEligibilityResult,
): void {
  console.info("PASSENGER_BOOKING_BLOCKED", JSON.stringify({
    edge,
    user_id: userId ?? null,
    auth_state: result.state,
    blocked_reasons: result.blocked_reasons,
  }));
}

/** Exported for tests — maps block code without async guard. */
export function blockCodeToBlockedReasons(
  blockCode: OnboardingLoginBlockCode | null,
): PassengerBlockedReason[] {
  switch (blockCode) {
    case ONBOARDING_LOGIN_BLOCK.EMAIL_NOT_VERIFIED:
      return [PASSENGER_BLOCKED_REASON.EMAIL_UNVERIFIED];
    case ONBOARDING_LOGIN_BLOCK.PHONE_NOT_VERIFIED:
      return [PASSENGER_BLOCKED_REASON.PHONE_UNVERIFIED];
    case ONBOARDING_LOGIN_BLOCK.NO_PROFILE:
      return [
        PASSENGER_BLOCKED_REASON.CUSTOMER_PROFILE_MISSING,
        PASSENGER_BLOCKED_REASON.ONBOARDING_INCOMPLETE,
      ];
    case ONBOARDING_LOGIN_BLOCK.ACCOUNT_NOT_ACTIVE:
      return [PASSENGER_BLOCKED_REASON.ONBOARDING_INCOMPLETE];
    default:
      return [PASSENGER_BLOCKED_REASON.ONBOARDING_INCOMPLETE];
  }
}
