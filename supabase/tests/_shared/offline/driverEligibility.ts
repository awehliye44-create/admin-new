/** Offline test/audit-only helpers; not part of Edge uploads. */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";

import {
  evaluateDriverOnboardingLogin,
  hasActiveUnverifiedPendingPhoneChange,
  ONBOARDING_LOGIN_BLOCK,
  type OnboardingLoginBlockCode,
} from "../../../functions/_shared/onboardingLoginGuard.ts";

import {
  documentStateToBlockedReasons,
  evaluateDriverDocumentState,
  type DriverDocumentEligibilityResult,
} from "../../../functions/_shared/driverDocumentEligibility.ts";
import { DriverEligibilityResult, canAcceptOfferByDriverId } from "../../../functions/_shared/driverEligibility.ts";


export async function assertCanAcceptOfferByDriverId(
  service: SupabaseClient,
  driverId: string | null | undefined,
): Promise<DriverEligibilityResult> {
  return canAcceptOfferByDriverId(service, driverId);
}

export * from "../../../functions/_shared/driverEligibility.ts";
export * from "../../../../shared/edgePresentation/driverEligibility.ts";
