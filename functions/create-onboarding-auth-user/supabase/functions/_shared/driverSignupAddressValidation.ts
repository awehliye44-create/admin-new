import { ISO_TO_COUNTRY_NAME, KNOWN_DRIVER_COUNTRY_ISO } from "./worldCountryIsoCodes.ts";

export const UK_COUNTRY_ALIASES = ["united kingdom", "uk", "gb", "great britain"] as const;

export interface DriverAddressInput {
  residential_address?: string;
  residentialAddress?: string;
  postcode?: string;
  city?: string;
  country?: string;
  country_code?: string;
  countryCode?: string;
}

export function isUkCountry(country: string, countryCode?: string): boolean {
  if (countryCode?.trim().toUpperCase() === "GB") return true;
  const normalized = country.trim().toLowerCase();
  return (UK_COUNTRY_ALIASES as readonly string[]).includes(normalized);
}

export function isValidUkPostcode(postcode: string): boolean {
  const normalized = postcode.trim().toUpperCase().replace(/\s+/g, " ");
  return /^[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}$/i.test(normalized);
}

export function normalizeDriverAddressInput(input: DriverAddressInput) {
  return {
    residentialAddress: String(input.residential_address ?? input.residentialAddress ?? "").trim(),
    postcode: String(input.postcode ?? "").trim(),
    city: String(input.city ?? "").trim(),
    country: String(input.country ?? "").trim(),
    countryCode: String(input.country_code ?? input.countryCode ?? "").trim().toUpperCase(),
  };
}

export function validateDriverSignupAddressInput(
  input: DriverAddressInput,
): { ok: true; normalized: ReturnType<typeof normalizeDriverAddressInput> } | { ok: false; error: string } {
  console.log("DRIVER_SIGNUP_ADDRESS_VALIDATION_STARTED", JSON.stringify({ ts: new Date().toISOString() }));
  const normalized = normalizeDriverAddressInput(input);

  if (!normalized.residentialAddress) {
    console.log("DRIVER_SIGNUP_ADDRESS_VALIDATION_FAILED", JSON.stringify({ reason: "missing_residential_address" }));
    return { ok: false, error: "Residential address is required." };
  }
  if (normalized.residentialAddress.length < 2) {
    console.log("DRIVER_SIGNUP_ADDRESS_VALIDATION_FAILED", JSON.stringify({ reason: "residential_address_too_short" }));
    return { ok: false, error: "Residential address must be at least 2 characters." };
  }
  if (!normalized.postcode) {
    console.log("DRIVER_SIGNUP_ADDRESS_VALIDATION_FAILED", JSON.stringify({ reason: "missing_postcode" }));
    return { ok: false, error: "Postcode is required." };
  }
  if (!normalized.city) {
    console.log("DRIVER_SIGNUP_ADDRESS_VALIDATION_FAILED", JSON.stringify({ reason: "missing_city" }));
    return { ok: false, error: "City is required." };
  }
  if (normalized.city.length < 2) {
    console.log("DRIVER_SIGNUP_ADDRESS_VALIDATION_FAILED", JSON.stringify({ reason: "city_too_short" }));
    return { ok: false, error: "City must be at least 2 characters." };
  }
  if (!normalized.countryCode || !KNOWN_DRIVER_COUNTRY_ISO.has(normalized.countryCode)) {
    console.log("DRIVER_SIGNUP_ADDRESS_VALIDATION_FAILED", JSON.stringify({ reason: "invalid_country_code" }));
    return { ok: false, error: "Select a country from the list." };
  }
  const canonicalName = ISO_TO_COUNTRY_NAME[normalized.countryCode];
  if (!canonicalName) {
    console.log("DRIVER_SIGNUP_ADDRESS_VALIDATION_FAILED", JSON.stringify({ reason: "unknown_country_code" }));
    return { ok: false, error: "Select a country from the list." };
  }
  normalized.country = canonicalName;
  if (isUkCountry(normalized.country, normalized.countryCode) && !isValidUkPostcode(normalized.postcode)) {
    console.log("DRIVER_SIGNUP_ADDRESS_VALIDATION_FAILED", JSON.stringify({ reason: "invalid_uk_postcode" }));
    return { ok: false, error: "Enter a valid UK postcode." };
  }

  return { ok: true, normalized };
}
