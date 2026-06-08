import {
  isPlaceholderName,
  resolveCustomerDisplayStatus,
  resolveDriverDisplayStatus,
  type AccountDisplayStatus,
} from "./onboardingValidation";

export { type AccountDisplayStatus };

export function formatAccountDisplayName(firstName?: string | null, lastName?: string | null): string {
  const first = (firstName ?? "").trim();
  const last = (lastName ?? "").trim();
  if (!first || !last || first.length < 2 || last.length < 2 || isPlaceholderName(first) || isPlaceholderName(last)) {
    console.warn("INVALID_ACCOUNT_DATA", { firstName: first, lastName: last });
    return "INVALID ACCOUNT DATA";
  }
  return `${first} ${last}`.trim();
}

export { resolveCustomerDisplayStatus, resolveDriverDisplayStatus };
