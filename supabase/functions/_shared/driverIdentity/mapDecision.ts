/**
 * Maps ONECAB identity decisions without leaking provider-specific enums.
 */

import type {
  OnecabIdentityDecision,
  ProviderDecisionPayload,
} from "./types.ts";

export function mapProviderDecisionPayload(
  input: ProviderDecisionPayload,
): OnecabIdentityDecision {
  const status = (input.status || "").toLowerCase().trim();
  const code = (input.code || input.reasonCode || "").toLowerCase().trim();

  if (status === "approved" || code === "approved") return "approved";
  if (
    status === "resubmission_requested" ||
    code === "resubmission_requested" ||
    status === "resubmission"
  ) {
    return "retry_required";
  }
  if (status === "review" || code === "review") return "manual_review";
  if (status === "expired" || code === "expired") return "expired";
  if (status === "abandoned" || code === "abandoned") {
    return "cancelled";
  }
  if (status === "declined" || code === "declined" || status === "rejected") {
    return input.declinedMapsTo ?? "rejected";
  }

  // Unknown decision → manual review rather than silent approve.
  return "manual_review";
}
