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
};

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

export function destinationLast4(identifier: string): string {
  const trimmed = identifier.trim();
  if (trimmed.length <= 4) return trimmed;
  return trimmed.slice(-4);
}

export function maskDestinationIdentifier(identifier: string): string {
  return `****${destinationLast4(identifier)}`;
}

export function buildMaskedDestinationLabel(args: {
  provider: string;
  destinationType: string;
  destinationLast4: string;
  accountHolderName?: string | null;
}): string {
  const typeLabel = destinationTypeLabel(args.provider, args.destinationType);
  const masked = `****${args.destinationLast4}`;
  const holder = args.accountHolderName?.trim();
  if (holder) return `${typeLabel} · ${holder} · ${masked}`;
  return `${typeLabel} ending ${masked}`;
}

export function validateDestinationIdentifier(
  destinationType: string,
  identifier: string,
): { ok: true } | { ok: false; message: string } {
  const trimmed = identifier.trim();
  if (!trimmed) {
    return { ok: false, message: "Account or wallet number is required." };
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

/**
 * Decrypt payout destination ciphertext produced by encryptDestinationIdentifier.
 * Fail-closed: malformed / undecryptable values throw (never return partial plaintext).
 * Callers must keep plaintext in-process only for the minimum provider-link scope and never log it.
 */
export async function decryptDestinationIdentifier(ciphertext: string): Promise<string> {
  const raw = String(ciphertext ?? "").trim();
  if (!raw) throw new Error("DESTINATION_CIPHERTEXT_EMPTY");

  let combined: Uint8Array;
  try {
    const binary = atob(raw);
    combined = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) combined[i] = binary.charCodeAt(i);
  } catch {
    throw new Error("DESTINATION_CIPHERTEXT_MALFORMED");
  }
  if (combined.length < 13) throw new Error("DESTINATION_CIPHERTEXT_MALFORMED");

  const iv = combined.slice(0, 12);
  const cipher = combined.slice(12);
  const keyBytes = await deriveEncryptionKeyBytes();
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );
  try {
    const plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipher);
    const plain = new TextDecoder().decode(plainBuf).trim();
    if (!plain) throw new Error("DESTINATION_PLAINTEXT_EMPTY");
    return plain;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("DESTINATION_")) throw err;
    throw new Error("DESTINATION_DECRYPTION_FAILED");
  }
}

/** Canonical verification statuses for driver payout destinations. */
export const DESTINATION_STATUS = {
  UNVERIFIED: "UNVERIFIED",
  PENDING: "PENDING",
  MANUAL_VERIFIED: "MANUAL_VERIFIED",
  PROVIDER_VERIFIED: "PROVIDER_VERIFIED",
  REJECTED: "REJECTED",
  DISABLED: "DISABLED",
  FAILED: "FAILED",
  UNKNOWN: "UNKNOWN",
} as const;

export type DestinationVerificationStatus =
  (typeof DESTINATION_STATUS)[keyof typeof DESTINATION_STATUS];

/**
 * Normalize destination verification_status for linkage gates.
 * Never upgrades unverified/failed/unknown to a verified status.
 * Unknown inputs fail closed as UNKNOWN (not verified).
 */
export function normalizeDestinationVerificationStatus(
  raw: string | null | undefined,
): DestinationVerificationStatus {
  const s = String(raw ?? "").trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (!s) return DESTINATION_STATUS.UNVERIFIED;
  if (s === "MANUAL_VERIFIED" || s === "MANUALLY_VERIFIED") {
    return DESTINATION_STATUS.MANUAL_VERIFIED;
  }
  if (s === "PROVIDER_VERIFIED" || s === "PROVIDER_CONFIRMED") {
    return DESTINATION_STATUS.PROVIDER_VERIFIED;
  }
  if (s === "REJECTED" || s === "REJECT") return DESTINATION_STATUS.REJECTED;
  if (s === "DISABLED" || s === "DISABLE") return DESTINATION_STATUS.DISABLED;
  if (s === "FAILED" || s === "FAIL" || s === "LINK_FAILED") {
    return DESTINATION_STATUS.FAILED;
  }
  if (s === "PENDING" || s === "PENDING_VERIFICATION" || s === "LINKING") {
    return DESTINATION_STATUS.PENDING;
  }
  if (s === "UNVERIFIED" || s === "NOT_VERIFIED") {
    return DESTINATION_STATUS.UNVERIFIED;
  }
  // Fail closed — never treat ambiguous "VERIFIED" / foreign values as verified.
  return DESTINATION_STATUS.UNKNOWN;
}

export type UkBankIdentifierParts = {
  sortCode: string;
  accountNumber: string;
};

/**
 * Parse a UK sort-code + account-number identifier.
 * Accepts digits-only (6+8..10), or delimited forms (|, :, /, whitespace, hyphens in sort).
 * Rejects malformed, partial, or non-UK-shaped values. Errors never include full identifiers.
 */
export function parseUkBankIdentifier(
  combined: string | null | undefined,
): UkBankIdentifierParts | null {
  const raw = String(combined ?? "").trim();
  if (!raw) return null;

  // Reject obvious IBAN / foreign prefixes without echoing them.
  const compactUpper = raw.replace(/\s+/g, "").toUpperCase();
  if (/^[A-Z]{2}\d{2}/.test(compactUpper) && compactUpper.length >= 15) {
    return null;
  }

  let sortCode = "";
  let accountNumber = "";

  const delimited = raw.split(/[|:\/,;]+/).map((p) => p.trim()).filter(Boolean);
  if (delimited.length === 2) {
    sortCode = delimited[0].replace(/\D/g, "");
    accountNumber = delimited[1].replace(/\D/g, "");
  } else {
    // "12-34-56 12345678" or "12345612345678"
    const parts = raw.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      sortCode = parts[0].replace(/\D/g, "");
      accountNumber = parts.slice(1).join("").replace(/\D/g, "");
    } else {
      const digits = raw.replace(/\D/g, "");
      if (digits.length < 14 || digits.length > 16) return null;
      sortCode = digits.slice(0, 6);
      accountNumber = digits.slice(6);
    }
  }

  if (sortCode.length !== 6) return null;
  if (accountNumber.length < 8 || accountNumber.length > 10) return null;
  if (!/^\d{6}$/.test(sortCode) || !/^\d+$/.test(accountNumber)) return null;
  return { sortCode, accountNumber };
}
