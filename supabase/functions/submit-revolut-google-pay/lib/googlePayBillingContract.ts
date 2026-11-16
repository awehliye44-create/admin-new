/**
 * Bug #37 — authoritative Google Pay → Revolut billing contract.
 * Wallet billing only. Never invent postcodes / never use trip addresses.
 *
 * Fabrication is prevented at the source (no client/Edge placeholders), not by
 * blacklisting genuine postcodes such as SW1A 1AA.
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
      code: "GOOGLE_PAY_BILLING_INCOMPLETE" | "GOOGLE_PAY_BILLING_FABRICATED";
      missing_fields: string[];
      field_presence: {
        street: boolean;
        city: boolean;
        region: boolean;
        postcode: boolean;
        country: boolean;
      };
    };

/**
 * Only reject values that are explicitly fabricated by our systems historically
 * (all-zero placeholders). Never reject genuine UK postcodes (incl. SW1A 1AA).
 */
export function isFabricatedGooglePayPostcode(postcode: string | null | undefined): boolean {
  const compact = String(postcode ?? "").trim().toUpperCase().replace(/\s+/g, "");
  if (!compact) return false; // emptiness handled separately
  // Historical Edge invented "000000" / all zeros — reject only that class.
  return /^0+$/.test(compact);
}

/** @deprecated Use isFabricatedGooglePayPostcode — kept name for older tests. */
export function isPlaceholderGooglePayPostcode(postcode: string | null | undefined): boolean {
  const trimmed = String(postcode ?? "").trim();
  if (!trimmed) return true;
  return isFabricatedGooglePayPostcode(trimmed);
}

/**
 * Revolut Merchant Google Pay Pay-for-order requires Address.postcode + country_code.
 * Countries without domestic postcodes still need a Wallet-supplied value for Revolut;
 * we never invent one — fail closed with recovery if Wallet omits it.
 * @see https://developer.revolut.com/docs/guides/accept-payments/.../google-pay
 */
export function revolutGooglePayRequiresPostcode(_countryCode: string | null | undefined): boolean {
  return true;
}

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

/**
 * Map client billing (Google Pay keys or Revolut keys) → Revolut Address.
 * Requires a genuine Wallet postcode (Revolut requirement). Country defaults to
 * GB only when Wallet omits it (ONECAB UK market); never invents postcode/street/city.
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

  if (revolutGooglePayRequiresPostcode(country) && !postcode) {
    return {
      ok: false,
      code: "GOOGLE_PAY_BILLING_INCOMPLETE",
      missing_fields: ["billing_address.postcode"],
      field_presence,
    };
  }
  if (postcode && isFabricatedGooglePayPostcode(postcode)) {
    return {
      ok: false,
      code: "GOOGLE_PAY_BILLING_FABRICATED",
      missing_fields: ["billing_address.postcode"],
      field_presence: { ...field_presence, postcode: false },
    };
  }
  if (!postcode) {
    return {
      ok: false,
      code: "GOOGLE_PAY_BILLING_INCOMPLETE",
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
