/** Shared onboarding field validation for customer + driver signup. */

export const PLACEHOLDER_NAMES = new Set([
  "customer user",
  "customer",
  "user",
  "driver user",
  "driver",
  "test",
  "unknown",
  "n/a",
  "na",
]);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type OnboardingFieldError =
  | "first_name_required"
  | "first_name_min_length"
  | "first_name_placeholder"
  | "last_name_required"
  | "last_name_min_length"
  | "last_name_placeholder"
  | "email_required"
  | "email_invalid"
  | "phone_required"
  | "phone_invalid"
  | "password_min_length";

export interface OnboardingSignupInput {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  password: string;
}

export interface OnboardingValidationResult {
  ok: boolean;
  errors: OnboardingFieldError[];
  normalized: {
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
  };
}

export function isPlaceholderName(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return false;
  return PLACEHOLDER_NAMES.has(normalized);
}

export function normalizeOnboardingEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function normalizeOnboardingPhone(phone: string): string {
  const trimmed = phone.trim();
  if (!trimmed) return "";
  const digits = trimmed.replace(/\D/g, "");
  if (trimmed.startsWith("+")) return `+${digits}`;
  if (digits.startsWith("00") && digits.length > 2) return `+${digits.slice(2)}`;
  if (digits.length >= 10) return `+${digits}`;
  return trimmed;
}

export function isValidOnboardingPhone(phone: string): boolean {
  const normalized = normalizeOnboardingPhone(phone);
  const digits = normalized.replace(/\D/g, "");
  return digits.length >= 10 && digits.length <= 15;
}

export function validateOnboardingSignup(
  input: OnboardingSignupInput,
  options: { minPasswordLength?: number } = {},
): OnboardingValidationResult {
  const minPasswordLength = options.minPasswordLength ?? 8;
  const errors: OnboardingFieldError[] = [];

  const firstName = input.firstName.trim();
  const lastName = input.lastName.trim();
  const email = normalizeOnboardingEmail(input.email);
  const phone = normalizeOnboardingPhone(input.phone);

  if (!firstName) errors.push("first_name_required");
  else if (firstName.length < 2) errors.push("first_name_min_length");
  else if (isPlaceholderName(firstName)) errors.push("first_name_placeholder");

  if (!lastName) errors.push("last_name_required");
  else if (lastName.length < 2) errors.push("last_name_min_length");
  else if (isPlaceholderName(lastName)) errors.push("last_name_placeholder");

  if (!email) errors.push("email_required");
  else if (!EMAIL_RE.test(email)) errors.push("email_invalid");

  if (!phone) errors.push("phone_required");
  else if (!isValidOnboardingPhone(phone)) errors.push("phone_invalid");

  if (!input.password || input.password.length < minPasswordLength) {
    errors.push("password_min_length");
  }

  return {
    ok: errors.length === 0,
    errors,
    normalized: { firstName, lastName, email, phone },
  };
}

export function onboardingErrorMessage(code: OnboardingFieldError): string {
  switch (code) {
    case "first_name_required":
      return "First name is required";
    case "first_name_min_length":
      return "First name must be at least 2 characters";
    case "first_name_placeholder":
      return "Please enter your real first name";
    case "last_name_required":
      return "Last name is required";
    case "last_name_min_length":
      return "Last name must be at least 2 characters";
    case "last_name_placeholder":
      return "Please enter your real last name";
    case "email_required":
      return "Email is required";
    case "email_invalid":
      return "Please enter a valid email address";
    case "phone_required":
      return "Phone number is required";
    case "phone_invalid":
      return "Please enter a valid phone number";
    case "password_min_length":
      return "Password must be at least 8 characters";
    default:
      return "Invalid signup details";
  }
}

export type AccountDisplayStatus =
  | "PENDING_VERIFICATION"
  | "PENDING_APPROVAL"
  | "ACTIVE"
  | "SUSPENDED"
  | "DISABLED"
  | "DELETED"
  | "INVALID_ACCOUNT_DATA";

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
