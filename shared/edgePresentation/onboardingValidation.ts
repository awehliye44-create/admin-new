/** Admin presentation-only helpers; not part of Edge uploads. */
/** Shared onboarding field validation for customer + driver signup. */

import { isValidE164Phone } from "../../supabase/functions/_shared/phoneValidation.ts";
import { AccountDisplayStatus, isPlaceholderName } from "../../supabase/functions/_shared/onboardingValidation.ts";


export function resolveCustomerDisplayStatus(args: {
  firstName?: string | null;
  lastName?: string | null;
  riderStatus?: string | null;
  emailVerified?: boolean | null;
  phoneVerified?: boolean | null;
  deletedAt?: string | null;
}): AccountDisplayStatus {
  const first = (args.firstName ?? "").trim();
  const last = (args.lastName ?? "").trim();
  if (!first || !last || first.length < 2 || last.length < 2 || isPlaceholderName(first) || isPlaceholderName(last)) {
    return "INVALID_ACCOUNT_DATA";
  }
  if (args.deletedAt || args.riderStatus === "deleted") return "DELETED";
  if (args.riderStatus === "suspended") return "SUSPENDED";
  if (args.riderStatus === "disabled") return "DISABLED";
  if (!args.emailVerified || !args.phoneVerified || args.riderStatus === "pending_verification") {
    return "PENDING_VERIFICATION";
  }
  return "ACTIVE";
}


export function resolveDriverDisplayStatus(args: {
  firstName?: string | null;
  lastName?: string | null;
  approvalStatus?: string | null;
  driverStatus?: string | null;
  emailVerified?: boolean | null;
  phoneVerified?: boolean | null;
  deletedAt?: string | null;
}): AccountDisplayStatus {
  const first = (args.firstName ?? "").trim();
  const last = (args.lastName ?? "").trim();
  if (!first || !last || first.length < 2 || last.length < 2 || isPlaceholderName(first) || isPlaceholderName(last)) {
    return "INVALID_ACCOUNT_DATA";
  }
  if (args.deletedAt || args.driverStatus === "deleted") return "DELETED";
  if (args.driverStatus === "disabled") return "DISABLED";
  if (args.approvalStatus === "suspended" || args.driverStatus === "suspended") return "SUSPENDED";
  if (!args.emailVerified || !args.phoneVerified) return "PENDING_VERIFICATION";
  if (args.approvalStatus === "pending") return "PENDING_APPROVAL";
  if (args.approvalStatus === "approved" && args.driverStatus === "active") return "ACTIVE";
  return "PENDING_APPROVAL";
}
