/** Admin presentation-only helpers; not part of Edge uploads. */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";

import {
  evaluateDriverOnboardingLogin,
  hasActiveUnverifiedPendingPhoneChange,
  ONBOARDING_LOGIN_BLOCK,
  type OnboardingLoginBlockCode,
} from "../../supabase/functions/_shared/onboardingLoginGuard.ts";

import {
  documentStateToBlockedReasons,
  evaluateDriverDocumentState,
  type DriverDocumentEligibilityResult,
} from "../../supabase/functions/_shared/driverDocumentEligibility.ts";
import { DriverEligibilityResult, evaluateDriverAuthState, DEFAULT_DRIVER_OFFER_BLOCKED_MESSAGE, canReceiveOffers } from "../../supabase/functions/_shared/driverEligibility.ts";


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


export async function canAcceptOffer(
  service: SupabaseClient,
  userId: string | null | undefined,
): Promise<DriverEligibilityResult> {
  return canReceiveOffers(service, userId);
}
