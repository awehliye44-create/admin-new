import { findCountryByIso, formatCountryWithFlag, isKnownCountryIso } from "@/lib/countryCodes";

export const UK_COUNTRY_ALIASES = ["united kingdom", "uk", "gb", "great britain"] as const;

export interface DriverAddressFields {
  residentialAddress: string;
  postcode: string;
  city: string;
  country: string;
  countryCode: string;
}

export type DriverAddressFieldKey = keyof DriverAddressFields;

export interface DriverAddressRow {
  residential_address?: string | null;
  postcode?: string | null;
  city?: string | null;
  country?: string | null;
  country_code?: string | null;
}

export function isUkCountry(country: string, countryCode?: string): boolean {
  if (countryCode?.trim().toUpperCase() === "GB") return true;
  const normalized = country.trim().toLowerCase();
  return (UK_COUNTRY_ALIASES as readonly string[]).includes(normalized);
}

export { formatCountryWithFlag };

export function isValidUkPostcode(postcode: string): boolean {
  const normalized = postcode.trim().toUpperCase().replace(/\s+/g, " ");
  return /^[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}$/i.test(normalized);
}

export function validateDriverAddressFields(
  fields: Partial<DriverAddressFields>,
): { ok: true; normalized: DriverAddressFields } | { ok: false; errors: Partial<Record<DriverAddressFieldKey, string>> } {
  const normalized: DriverAddressFields = {
    residentialAddress: (fields.residentialAddress ?? "").trim(),
    postcode: (fields.postcode ?? "").trim(),
    city: (fields.city ?? "").trim(),
    country: (fields.country ?? "").trim(),
    countryCode: (fields.countryCode ?? "").trim().toUpperCase(),
  };
  const errors: Partial<Record<DriverAddressFieldKey, string>> = {};

  if (!normalized.residentialAddress) errors.residentialAddress = "Residential address is required.";
  else if (normalized.residentialAddress.length < 2) errors.residentialAddress = "Residential address must be at least 2 characters.";

  if (!normalized.postcode) errors.postcode = "Postcode is required.";
  else if (isUkCountry(normalized.country, normalized.countryCode) && !isValidUkPostcode(normalized.postcode)) {
    errors.postcode = "Enter a valid UK postcode.";
  }

  if (!normalized.city) errors.city = "City is required.";
  else if (normalized.city.length < 2) errors.city = "City must be at least 2 characters.";

  if (!normalized.countryCode || !isKnownCountryIso(normalized.countryCode)) {
    errors.country = "Select a country from the list.";
  } else {
    const entry = findCountryByIso(normalized.countryCode);
    if (!entry) errors.country = "Select a country from the list.";
    else normalized.country = entry.name;
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, normalized };
}

export function driverAddressFromRow(
  driver: (DriverAddressRow & Partial<DriverAddressFields>) | null | undefined,
): DriverAddressFields {
  return {
    residentialAddress: (driver?.residentialAddress ?? driver?.residential_address ?? "").trim(),
    postcode: (driver?.postcode ?? "").trim(),
    city: (driver?.city ?? "").trim(),
    country: (driver?.country ?? "").trim(),
    countryCode: (driver?.countryCode ?? driver?.country_code ?? "").trim().toUpperCase(),
  };
}

export function driverHasCompleteAddress(
  driver: (DriverAddressRow & Partial<DriverAddressFields>) | null | undefined,
): boolean {
  if (!driver) return false;
  return validateDriverAddressFields(driverAddressFromRow(driver)).ok;
}

export function formatDriverAddressCompact(
  driver: (DriverAddressRow & Partial<DriverAddressFields>) | null | undefined,
): string {
  if (!driverHasCompleteAddress(driver)) return "Address missing";
  const address = driverAddressFromRow(driver);
  return `${address.residentialAddress}, ${address.city}, ${address.postcode}`;
}

export function formatDriverAddressFull(
  driver: (DriverAddressRow & Partial<DriverAddressFields>) | null | undefined,
): string {
  if (!driverHasCompleteAddress(driver)) return "Address missing";
  const address = driverAddressFromRow(driver);
  return `${address.residentialAddress}, ${address.city}, ${address.postcode}, ${address.country}`;
}
