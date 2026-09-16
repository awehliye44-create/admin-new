/**
 * Corporate service-area country SSOT.
 *
 * A corporate account may only attach to an active service area whose
 * region.country_code matches the ISO country resolved from the company
 * address/postcode. Currency follows that region's currency_code.
 *
 * Do not maintain a parallel country/currency table. Do not hard-code
 * city or country display names.
 */

export const CORPORATE_SERVICE_UNAVAILABLE_MESSAGE =
  "ONECAB corporate service is not yet available in your area.";

export const SERVICE_AREA_COUNTRY_MISMATCH = "SERVICE_AREA_COUNTRY_MISMATCH";

/** Mapbox / informal alias — ISO 3166-1 for the United Kingdom is GB. */
const COUNTRY_ALIASES: Record<string, string> = {
  UK: "GB",
};

export function normalizeIsoCountryCode(raw: string | null | undefined): string | null {
  const v = String(raw ?? "").trim().toUpperCase();
  if (!v) return null;
  const aliased = COUNTRY_ALIASES[v] ?? v;
  if (!/^[A-Z]{2}$/.test(aliased)) return null;
  if (aliased === "XX" || aliased === "T1") return null;
  return aliased;
}

export function serviceAreaCountryMatches(
  accountCountry: string | null | undefined,
  serviceAreaCountry: string | null | undefined,
): boolean {
  const account = normalizeIsoCountryCode(accountCountry);
  const area = normalizeIsoCountryCode(serviceAreaCountry);
  return account != null && area != null && account === area;
}

export function assertServiceAreaCountryMatch(
  accountCountry: string | null | undefined,
  serviceAreaCountry: string | null | undefined,
): void {
  if (!serviceAreaCountryMatches(accountCountry, serviceAreaCountry)) {
    throw new Error(SERVICE_AREA_COUNTRY_MISMATCH);
  }
}

export type CorporateServiceAreaOption = {
  id: string;
  name: string;
  code: string | null;
  country_code: string;
  currency_code: string | null;
  sort_distance_m: number | null;
};
