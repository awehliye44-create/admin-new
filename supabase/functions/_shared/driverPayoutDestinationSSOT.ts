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

/* Stripe Connect provider-status helper removed — Connect payout UI retired. */
