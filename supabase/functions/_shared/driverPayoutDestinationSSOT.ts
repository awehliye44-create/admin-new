/**
 * Driver payout destination SSOT — provider catalogs, validation, encryption, masking.
 */

export const PAYOUT_DESTINATION_NOT_CONFIGURED = "PAYOUT_DESTINATION_NOT_CONFIGURED";

export type PayoutDestinationTypeOption = {
  id: string;
  label: string;
};

export const DRIVER_PAYOUT_DESTINATION_CATALOG: Record<string, PayoutDestinationTypeOption[]> = {
  sifalo_pay: [
    { id: "evc_plus", label: "EVC Plus" },
    { id: "zaad", label: "ZAAD" },
    { id: "taaj", label: "Taaj" },
    { id: "premier_bank", label: "Premier Bank" },
    { id: "sahal_pay", label: "Sahal Pay" },
    { id: "waafi_pay", label: "WaafiPay" },
    { id: "bank_account", label: "Bank Account" },
  ],
  intasend: [
    { id: "mpesa", label: "M-Pesa" },
    { id: "airtel_money", label: "Airtel Money" },
    { id: "bank_account", label: "Bank Account" },
  ],
  paystack: [
    { id: "mobile_money", label: "Mobile Money" },
    { id: "bank_account", label: "Bank Account" },
  ],
  hubtel: [
    { id: "mobile_money", label: "Mobile Money" },
    { id: "bank_account", label: "Bank Account" },
  ],
  flutterwave: [
    { id: "mobile_money", label: "Mobile Money" },
    { id: "bank_account", label: "Bank Account" },
  ],
  pesapal: [
    { id: "mobile_money", label: "Mobile Money" },
    { id: "bank_account", label: "Bank Account" },
  ],
  dpo_pay: [
    { id: "mobile_money", label: "Mobile Money" },
    { id: "bank_account", label: "Bank Account" },
  ],
  waafi_pay: [
    { id: "waafi_pay", label: "WaafiPay" },
    { id: "bank_account", label: "Bank Account" },
  ],
  sahal_pay: [
    { id: "sahal_pay", label: "Sahal Pay" },
    { id: "bank_account", label: "Bank Account" },
  ],
  noda: [
    { id: "bank_account", label: "Bank Account" },
  ],
  revolut: [
    { id: "uk_bank_account", label: "UK Bank Account" },
    { id: "iban", label: "IBAN" },
  ],
};

/** Region-aware catalog — UK Revolut payouts use sort code + account number only. */
export function supportedDestinationTypesForProviderAndCurrency(
  provider: string | null | undefined,
  currencyCode: string | null | undefined,
): PayoutDestinationTypeOption[] {
  const base = supportedDestinationTypesForProvider(provider);
  if (provider === "revolut" && (currencyCode ?? "GBP").toUpperCase() === "GBP") {
    return base.filter((t) => t.id === "uk_bank_account");
  }
  return base;
}

export function supportedDestinationTypesForProvider(
  provider: string | null | undefined,
): PayoutDestinationTypeOption[] {
  if (!provider) return [];
  return DRIVER_PAYOUT_DESTINATION_CATALOG[provider] ?? [
    { id: "mobile_money", label: "Mobile Money" },
    { id: "bank_account", label: "Bank Account" },
  ];
}

export function destinationTypeLabel(provider: string, destinationType: string): string {
  return supportedDestinationTypesForProvider(provider).find((t) => t.id === destinationType)?.label
    ?? destinationType.replace(/_/g, " ");
}

export function isDestinationTypeAllowed(provider: string, destinationType: string): boolean {
  return supportedDestinationTypesForProvider(provider).some((t) => t.id === destinationType);
}

export function isDestinationTypeAllowedForProvider(
  provider: string,
  destinationType: string,
  currencyCode?: string | null,
): boolean {
  return supportedDestinationTypesForProviderAndCurrency(provider, currencyCode)
    .some((t) => t.id === destinationType);
}

/** Canonical destination verification statuses (persistence SSOT). */
export type PayoutDestinationVerificationStatus =
  | "DRAFT"
  | "PENDING_VERIFICATION"
  | "MANUAL_VERIFIED"
  | "PROVIDER_PENDING"
  | "PROVIDER_VERIFIED"
  | "REJECTED"
  | "DISABLED"
  // legacy
  | "pending"
  | "verified"
  | "manual_verified";

export const DESTINATION_STATUS = {
  DRAFT: "DRAFT",
  PENDING_VERIFICATION: "PENDING_VERIFICATION",
  MANUAL_VERIFIED: "MANUAL_VERIFIED",
  PROVIDER_PENDING: "PROVIDER_PENDING",
  PROVIDER_VERIFIED: "PROVIDER_VERIFIED",
  REJECTED: "REJECTED",
  DISABLED: "DISABLED",
} as const;

export type DriverPayoutDestinationErrorCode =
  | "INVALID_ACCOUNT_HOLDER_NAME"
  | "INVALID_SORT_CODE"
  | "INVALID_ACCOUNT_NUMBER"
  | "DESTINATION_ALREADY_EXISTS"
  | "DESTINATION_ENCRYPTION_FAILED"
  | "DRIVER_NOT_AUTHORISED"
  | "INVALID_DESTINATION_TYPE"
  | "PAYMENT_GATEWAY_NOT_CONFIGURED";

export function normalizeDestinationVerificationStatus(
  status: string | null | undefined,
): PayoutDestinationVerificationStatus {
  const raw = String(status ?? "").trim();
  const upper = raw.toUpperCase();
  if (upper === "PENDING" || upper === "PENDING_VERIFICATION") return "PENDING_VERIFICATION";
  if (upper === "MANUAL_VERIFIED") return "MANUAL_VERIFIED";
  if (upper === "VERIFIED" || upper === "PROVIDER_VERIFIED") return "PROVIDER_VERIFIED";
  if (upper === "PROVIDER_PENDING") return "PROVIDER_PENDING";
  if (upper === "DRAFT") return "DRAFT";
  if (upper === "REJECTED") return "REJECTED";
  if (upper === "DISABLED") return "DISABLED";
  if (raw === "manual_verified") return "MANUAL_VERIFIED";
  if (raw === "pending") return "PENDING_VERIFICATION";
  if (raw === "verified") return "PROVIDER_VERIFIED";
  return "PENDING_VERIFICATION";
}

export function isDestinationPendingVerification(status: string | null | undefined): boolean {
  return normalizeDestinationVerificationStatus(status) === "PENDING_VERIFICATION";
}

export function isDestinationManualVerified(status: string | null | undefined): boolean {
  return normalizeDestinationVerificationStatus(status) === "MANUAL_VERIFIED";
}

export function isDestinationProviderVerified(status: string | null | undefined): boolean {
  return normalizeDestinationVerificationStatus(status) === "PROVIDER_VERIFIED";
}

/** Destination saved (any non-disabled active status). */
export function isDestinationSaved(status: string | null | undefined): boolean {
  const normalized = normalizeDestinationVerificationStatus(status);
  return normalized !== "DISABLED" && normalized !== "REJECTED" && normalized !== "DRAFT";
}

/** Eligible for external/manual payout recording. */
export function isDestinationManualPayoutEligible(status: string | null | undefined): boolean {
  const normalized = normalizeDestinationVerificationStatus(status);
  return normalized === "MANUAL_VERIFIED" || normalized === "PROVIDER_VERIFIED";
}

/** Eligible for future Revolut API payout. */
export function isDestinationApiPayoutEligible(status: string | null | undefined): boolean {
  return isDestinationProviderVerified(status);
}

export function parseUkBankIdentifier(
  identifier: string,
): { sortCode: string; accountNumber: string } | null {
  const digits = identifier.replace(/\D/g, "");
  if (digits.length < 14 || digits.length > 16) return null;
  const sortCode = digits.slice(0, 6);
  const accountNumber = digits.slice(6);
  if (sortCode.length !== 6 || accountNumber.length < 8 || accountNumber.length > 10) return null;
  return { sortCode, accountNumber };
}

export function buildUkBankSortCodeMask(sortCode: string): {
  sort_code_last2: string;
  masked_sort_code: string;
} {
  const digits = sortCode.replace(/\D/g, "").slice(0, 6);
  const last2 = digits.slice(-2).padStart(2, "0");
  return {
    sort_code_last2: last2,
    masked_sort_code: `**-**-${last2}`,
  };
}

export function destinationLast4(identifier: string): string {
  const trimmed = identifier.trim();
  if (trimmed.length <= 4) return trimmed;
  return trimmed.slice(-4);
}

export function maskAccountNumberLast4(last4: string): string {
  const digits = last4.replace(/\D/g, "").slice(-4);
  return `••••${digits}`;
}

export function maskDestinationIdentifier(identifier: string): string {
  return maskAccountNumberLast4(destinationLast4(identifier));
}

/** Validate UK bank / holder for destination persistence (no provider calls). */
export function validateUkBankDestinationSave(args: {
  accountHolderName?: string | null;
  sortCode?: string | null;
  accountNumber?: string | null;
  destinationIdentifier?: string | null;
}):
  | {
    ok: true;
    sortCode: string;
    accountNumber: string;
    destinationIdentifier: string;
    accountHolderName: string;
  }
  | { ok: false; code: DriverPayoutDestinationErrorCode; message: string } {
  const holder = (args.accountHolderName ?? "").trim();
  if (holder.length < 2) {
    return {
      ok: false,
      code: "INVALID_ACCOUNT_HOLDER_NAME",
      message: "Account holder name is required.",
    };
  }

  let sortCode = (args.sortCode ?? "").replace(/\D/g, "");
  let accountNumber = (args.accountNumber ?? "").replace(/\D/g, "");
  if ((!sortCode || !accountNumber) && args.destinationIdentifier) {
    const parsed = parseUkBankIdentifier(args.destinationIdentifier);
    if (parsed) {
      sortCode = parsed.sortCode;
      accountNumber = parsed.accountNumber;
    }
  }

  if (sortCode.length !== 6) {
    return {
      ok: false,
      code: "INVALID_SORT_CODE",
      message: "Enter a valid 6-digit sort code.",
    };
  }
  if (accountNumber.length < 8 || accountNumber.length > 10) {
    return {
      ok: false,
      code: "INVALID_ACCOUNT_NUMBER",
      message: "Enter a valid 8-digit account number.",
    };
  }

  return {
    ok: true,
    sortCode,
    accountNumber,
    destinationIdentifier: `${sortCode}${accountNumber}`,
    accountHolderName: holder,
  };
}

export function buildMaskedDestinationLabel(args: {
  provider: string;
  destinationType: string;
  destinationLast4: string;
  accountHolderName?: string | null;
  maskedSortCode?: string | null;
}): string {
  const typeLabel = destinationTypeLabel(args.provider, args.destinationType);
  const maskedAccount = maskAccountNumberLast4(args.destinationLast4);
  const holder = args.accountHolderName?.trim();
  const sortMask = args.maskedSortCode?.trim();

  if (args.destinationType === "uk_bank_account" && sortMask) {
    const bankLine = `${sortMask} · ${maskedAccount}`;
    if (holder) return `${typeLabel} · ${holder} · ${bankLine}`;
    return `${typeLabel} · ${bankLine}`;
  }

  if (holder) return `${typeLabel} · ${holder} · ${maskedAccount}`;
  return `${typeLabel} ending ${maskedAccount}`;
}

export function validateDestinationIdentifier(
  destinationType: string,
  identifier: string,
): { ok: true } | { ok: false; message: string } {
  const trimmed = identifier.trim();
  if (!trimmed) {
    return { ok: false, message: "Account or wallet number is required." };
  }
  if (destinationType === "iban") {
    const normalized = trimmed.replace(/\s/g, "").toUpperCase();
    if (!/^[A-Z]{2}[0-9A-Z]{13,32}$/.test(normalized)) {
      return { ok: false, message: "Enter a valid IBAN." };
    }
    return { ok: true };
  }
  if (destinationType === "uk_bank_account") {
    const digits = trimmed.replace(/\D/g, "");
    if (digits.length < 14 || digits.length > 16) {
      return {
        ok: false,
        message: "Enter a valid 6-digit sort code and 8-digit account number.",
      };
    }
    const sortCode = digits.slice(0, 6);
    const accountNo = digits.slice(6);
    if (sortCode.length !== 6 || accountNo.length < 8 || accountNo.length > 10) {
      return {
        ok: false,
        message: "Enter a valid 6-digit sort code and 8-digit account number.",
      };
    }
    return { ok: true };
  }
  if (destinationType === "revolut_account") {
    const revtag = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
    if (!/^[a-zA-Z][a-zA-Z0-9_]{2,31}$/.test(revtag)) {
      return {
        ok: false,
        message: "Enter your Revolut @revtag (e.g. johnsmith), not a phone number or account ID.",
      };
    }
    return { ok: true };
  }
  if (destinationType === "bank_account") {
    if (trimmed.length < 6 || trimmed.length > 34) {
      return { ok: false, message: "Enter a valid bank account number." };
    }
    return { ok: true };
  }
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) {
    return { ok: false, message: "Enter a valid mobile money or wallet number." };
  }
  return { ok: true };
}

const ENCRYPTION_KEY_ENV = "PAYOUT_DESTINATION_ENCRYPTION_KEY";

async function deriveEncryptionKeyBytes(): Promise<Uint8Array> {
  const explicit = Deno.env.get(ENCRYPTION_KEY_ENV)?.trim();
  const seed = explicit && explicit.length >= 32
    ? explicit
    : (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "onecab-payout-destination-default-key");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed));
  return new Uint8Array(digest);
}

export async function encryptDestinationIdentifier(plaintext: string): Promise<string> {
  const keyBytes = await deriveEncryptionKeyBytes();
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext.trim());
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
  const combined = new Uint8Array(iv.length + cipher.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(cipher), iv.length);
  return btoa(String.fromCharCode(...combined));
}

export async function decryptDestinationIdentifier(ciphertextB64: string): Promise<string> {
  const keyBytes = await deriveEncryptionKeyBytes();
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );
  const combined = Uint8Array.from(atob(ciphertextB64), (c) => c.charCodeAt(0));
  if (combined.length < 13) throw new Error("DESTINATION_DECRYPTION_FAILED");
  const iv = combined.slice(0, 12);
  const data = combined.slice(12);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
  return new TextDecoder().decode(plain);
}

export function stripeConnectProviderStatus(args: {
  stripe_account_id: string | null;
  payouts_enabled: boolean | null;
  onboarding_complete: boolean | null;
  charges_enabled: boolean | null;
}): "connected" | "not_connected" | "restricted" {
  if (!args.stripe_account_id) return "not_connected";
  if (args.payouts_enabled && args.onboarding_complete) return "connected";
  if (args.charges_enabled || args.onboarding_complete) return "restricted";
  return "not_connected";
}
