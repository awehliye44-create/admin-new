/** Password reset SSOT helpers — OTP only to current verified registered phone. */

import { normalizeOnboardingPhone } from "./onboardingValidation.ts";

export function phonesMatchForPasswordReset(a: string, b: string): boolean {
  const na = normalizeOnboardingPhone(a).replace(/^\+/, "");
  const nb = normalizeOnboardingPhone(b).replace(/^\+/, "");
  return na === nb && na.length > 0;
}
