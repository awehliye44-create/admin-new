/**
 * Customer copy for a tip that could not be authorised (CUSTOMER_SUBMIT_WITH_TIP).
 *
 * Bank/issuer wording is allowed only when Revolut itself declined the increment
 * (providerDeclineEvidence present). An authorised total that merely stayed below
 * target, a provider (technical) failure, or any other/unknown outcome must never
 * be described as a bank decline, and no decline reason is ever inferred.
 *
 * The installed Customer App selects its popup copy by error_code, so a non-decline
 * uses CAPTURE_FAILED: neutral copy, and Rate Trip still offers Continue without tip.
 */

export type TipAuthorisationOutcome = "declined" | "provider_failed" | "unknown";

export const TIP_AUTHORISATION_DECLINED_COPY =
  "Your bank declined the tip. Your fare has not been taken yet. You can try again, continue without a tip, or skip.";

export const TIP_AUTHORISATION_NOT_AUTHORISED_COPY =
  "We couldn't authorise the tip payment. Your fare has not been taken yet. You can try again, continue without a tip, or skip.";

export function tipAuthorisationOutcomeFromIncrementKind(
  kind: string | null | undefined,
  providerDeclineEvidence?: string | null,
): TipAuthorisationOutcome {
  if (kind === "declined" && providerDeclineEvidence) return "declined";
  if (kind === "provider_failed") return "provider_failed";
  return "unknown";
}

export function normalizeTipAuthorisationOutcome(raw: unknown): TipAuthorisationOutcome {
  const value = String(raw ?? "").trim().toLowerCase();
  if (value === "declined") return "declined";
  if (value === "provider_failed") return "provider_failed";
  return "unknown";
}

export function tipAuthorisationCustomerCopy(outcome: TipAuthorisationOutcome): string {
  return outcome === "declined" ? TIP_AUTHORISATION_DECLINED_COPY : TIP_AUTHORISATION_NOT_AUTHORISED_COPY;
}

export function tipAuthorisationCustomerErrorCode(
  outcome: TipAuthorisationOutcome,
): "TIP_AUTHORISATION_DECLINED" | "CAPTURE_FAILED" {
  return outcome === "declined" ? "TIP_AUTHORISATION_DECLINED" : "CAPTURE_FAILED";
}
