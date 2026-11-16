/**
 * Bug #37 — authoritative Google Pay → Revolut billing contract.
 * Wallet billing only. Never invent postcodes / never use trip addresses.
 */

export type GooglePayBillingInput = Record<string, unknown> | null | undefined;

export type RevolutGooglePayBilling = {
  street_line_1?: string;
  street_line_2?: string;
  city?: string;
  region?: string;
  postcode: string;
  country_code: string;
};

export type GooglePayBillingContractResult =
  | {
      ok: true;
      billing: RevolutGooglePayBilling;
      field_presence: {
        street: boolean;
        city: boolean;
        region: boolean;
        postcode: boolean;
        country: boolean;
      };
    }
  | {
      ok: false;
      code: "GOOGLE_PAY_BILLING_INCOMPLETE" | "GOOGLE_PAY_BILLING_PLACEHOLDER";
      missing_fields: string[];
      field_presence: {
        street: boolean;
        city: boolean;
        region: boolean;
        postcode: boolean;
        country: boolean;
      };
    };

/** Known fabricated / probe values that must never reach Revolut. */
const PLACEHOLDER_POSTCODES = new Set([
  "000000",
  "00000",
  "0000",
  "SW1A1AA",
  "SW1A 1AA",
  "TEST",
  "N/A",
  "NA",
  "NONE",
  "NULL",
]);

function trimStr(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t.length > 0 ? t : null;
}

function firstString(raw: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const v = trimStr(raw[key]);
    if (v) return v;
  }
  return null;
}

export function isPlaceholderGooglePayPostcode(postcode: string | null | undefined): boolean {
  const normalized = String(postcode ?? "").trim().toUpperCase().replace(/\s+/g, " ");
  if (!normalized) return true;
  if (PLACEHOLDER_POSTCODES.has(normalized)) return true;
  if (PLACEHOLDER_POSTCODES.has(normalized.replace(/\s+/g, ""))) return true;
  // All zeros
  if (/^0+$/.test(normalized.replace(/\s+/g, ""))) return true;
  return false;
}

/**
 * Map client billing (Google Pay keys or Revolut keys) → Revolut Address.
 * Requires a genuine postcode. Country defaults to GB only when Wallet omits it
 * (ONECAB UK market); never invents postcode/street/city.
 */
export function resolveGooglePayBillingContract(
  raw: GooglePayBillingInput,
): GooglePayBillingContractResult {
  const b = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const street = firstString(b, ["street_line_1", "address1"]);
  const street2 = firstString(b, ["street_line_2", "address2"]);
  const city = firstString(b, ["city", "locality"]);
  const region = firstString(b, ["region", "administrativeArea"]);
  const postcode = firstString(b, ["postcode", "postalCode", "zip", "postal_code"]);
  const countryRaw = firstString(b, ["country_code", "countryCode", "country"]);
  const country = (countryRaw ?? "GB").toUpperCase();

  const field_presence = {
    street: Boolean(street),
    city: Boolean(city),
    region: Boolean(region),
    postcode: Boolean(postcode),
    country: Boolean(countryRaw),
  };

  if (!postcode) {
    return {
      ok: false,
      code: "GOOGLE_PAY_BILLING_INCOMPLETE",
      missing_fields: ["billing_address.postcode"],
      field_presence,
    };
  }
  if (isPlaceholderGooglePayPostcode(postcode)) {
    return {
      ok: false,
      code: "GOOGLE_PAY_BILLING_PLACEHOLDER",
      missing_fields: ["billing_address.postcode"],
      field_presence,
    };
  }

  return {
    ok: true,
    billing: {
      ...(street ? { street_line_1: street } : {}),
      ...(street2 ? { street_line_2: street2 } : {}),
      ...(city ? { city } : {}),
      ...(region ? { region } : {}),
      postcode,
      country_code: country,
    },
    field_presence,
  };
}
