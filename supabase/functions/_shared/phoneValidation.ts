/**
 * E.164 phone validation for edge functions (Deno).
 * Uses ISO 3166-1 alpha-2 country codes — never dial codes (+252).
 *
 * Somalia (+252): libphonenumber metadata includes NCA operator prefixes —
 * Hormuud 61/77/78, Somtel 62/65/66, Telesom-Zaad 63, Golis 90, etc.
 */
import {
  parsePhoneNumberFromString,
  type CountryCode,
} from "https://esm.sh/libphonenumber-js@1.12.42";

export function isValidE164Phone(phone: string): boolean {
  const normalized = normalizePhoneInput(phone);
  if (!normalized) return false;
  const parsed = parsePhoneNumberFromString(normalized);
  return parsed?.isValid() ?? false;
}

export function validatePhoneForCountry(
  raw: string,
  countryIso: string,
): { valid: boolean; e164?: string } {
  const country = countryIso.trim().toUpperCase() as CountryCode;
  if (!country || country.length !== 2) return { valid: false };

  const normalized = normalizePhoneInput(raw);
  if (!normalized) return { valid: false };

  const parsed = normalized.startsWith("+")
    ? parsePhoneNumberFromString(normalized)
    : parsePhoneNumberFromString(normalized, country);

  if (!parsed?.isValid()) return { valid: false };
  return { valid: true, e164: parsed.number };
}

function normalizePhoneInput(phone: string): string {
  const trimmed = (phone || "").trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("00")) return `+${trimmed.slice(2).replace(/\D/g, "")}`;
  if (trimmed.startsWith("+")) return `+${trimmed.slice(1).replace(/\D/g, "")}`;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length >= 10) return `+${digits}`;
  return trimmed;
}
