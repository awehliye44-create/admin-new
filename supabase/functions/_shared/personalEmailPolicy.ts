/**
 * Personal end-user email policy.
 * ONECAB-owned domains must never be used as Driver/Customer personal recipients.
 * They remain valid only for From, Reply-To, internal ops alerts, Admin users,
 * and Corporate billed-party contracts where the company is genuinely the payer.
 */

export const ONECAB_OWNED_EMAIL_DOMAINS = [
  "onecab.net",
  "onecab.com",
  "adminonecab.net",
] as const;

export type PersonalEmailPurpose =
  | "email_change"
  | "signup_verification"
  | "password_reset"
  | "personal_trip_invoice"
  | "driver_confirmed"
  | "customer_confirmed";

export type PersonalEmailPolicyResult =
  | { ok: true; normalizedEmail: string }
  | {
    ok: false;
    code:
      | "INVALID_EMAIL"
      | "RECIPIENT_POLICY_VIOLATION"
      | "PLACEHOLDER_EMAIL";
    message: string;
  };

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizePersonalEmail(raw: string): string {
  return String(raw ?? "").trim().toLowerCase();
}

export function emailLocalAndDomain(email: string): { local: string; domain: string } {
  const normalized = normalizePersonalEmail(email);
  const at = normalized.lastIndexOf("@");
  if (at < 1) return { local: normalized, domain: "" };
  return {
    local: normalized.slice(0, at),
    domain: normalized.slice(at + 1),
  };
}

export function isOnecabOwnedEmailDomain(domainOrEmail: string): boolean {
  const raw = normalizePersonalEmail(domainOrEmail);
  const domain = raw.includes("@") ? emailLocalAndDomain(raw).domain : raw;
  if (!domain) return false;
  return ONECAB_OWNED_EMAIL_DOMAINS.some(
    (owned) => domain === owned || domain.endsWith(`.${owned}`),
  );
}

/** Auth placeholders used until a real email exists — not deliverable personal recipients. */
export function isPlaceholderPersonalEmail(email: string): boolean {
  const { domain } = emailLocalAndDomain(email);
  return (
    domain === "pending.onecab.local" ||
    domain.endsWith(".pending.onecab.local") ||
    domain === "placeholder.local"
  );
}

/**
 * Validate an address for use as a Driver/Customer personal recipient.
 * Does NOT apply to Corporate billed-party resolution (use corporate contract separately).
 */
export function assertPersonalEndUserEmail(
  raw: string,
  _purpose?: PersonalEmailPurpose,
): PersonalEmailPolicyResult {
  const normalizedEmail = normalizePersonalEmail(raw);
  if (normalizedEmail.length < 5 || !EMAIL_REGEX.test(normalizedEmail)) {
    return {
      ok: false,
      code: "INVALID_EMAIL",
      message: "Invalid email address.",
    };
  }
  if (isPlaceholderPersonalEmail(normalizedEmail)) {
    return {
      ok: false,
      code: "PLACEHOLDER_EMAIL",
      message: "A real personal email address is required.",
    };
  }
  if (isOnecabOwnedEmailDomain(normalizedEmail)) {
    return {
      ok: false,
      code: "RECIPIENT_POLICY_VIOLATION",
      message:
        "ONECAB company addresses cannot be used as a personal Driver or Customer email. Use your own email address.",
    };
  }
  return { ok: true, normalizedEmail };
}

export function classifyExistingPersonalEmail(raw: string | null | undefined): {
  status: "ok" | "missing" | "invalid" | "recipient_policy_violation" | "placeholder";
  normalizedEmail: string | null;
} {
  if (raw == null || String(raw).trim() === "") {
    return { status: "missing", normalizedEmail: null };
  }
  const result = assertPersonalEndUserEmail(String(raw));
  if (result.ok) return { status: "ok", normalizedEmail: result.normalizedEmail };
  if (result.code === "RECIPIENT_POLICY_VIOLATION") {
    return {
      status: "recipient_policy_violation",
      normalizedEmail: normalizePersonalEmail(String(raw)),
    };
  }
  if (result.code === "PLACEHOLDER_EMAIL") {
    return {
      status: "placeholder",
      normalizedEmail: normalizePersonalEmail(String(raw)),
    };
  }
  return { status: "invalid", normalizedEmail: normalizePersonalEmail(String(raw)) };
}

export function maskEmailForAdmin(email: string | null | undefined): string {
  if (!email) return "—";
  const normalized = normalizePersonalEmail(email);
  const { local, domain } = emailLocalAndDomain(normalized);
  if (!domain) return "***";
  const visible = local.length <= 2 ? "*" : `${local[0]}***${local[local.length - 1]}`;
  return `${visible}@${domain}`;
}
