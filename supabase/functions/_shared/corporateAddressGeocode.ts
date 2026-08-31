import { normalizeIsoCountryCode } from "../../../shared/corporateServiceAreaCountrySSOT.ts";

export type CorporateGeocodeResult = {
  countryCode: string;
  latitude: number;
  longitude: number;
  formattedAddress: string | null;
  city: string | null;
};

function mapboxReferer(): string {
  return Deno.env.get("MAPBOX_REFERER") || "https://co.onecab.net/";
}

function mbFetch(url: string): Promise<Response> {
  return fetch(url, { headers: { Referer: mapboxReferer() } });
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function extractCountryCode(feature: Record<string, unknown>): string | null {
  const props = (feature.properties && typeof feature.properties === "object"
    ? feature.properties
    : {}) as Record<string, unknown>;
  const context = (props.context && typeof props.context === "object"
    ? props.context
    : {}) as Record<string, unknown>;
  const countryObj = (context.country && typeof context.country === "object"
    ? context.country
    : {}) as Record<string, unknown>;

  const fromV6 = normalizeIsoCountryCode(
    readString(countryObj.country_code) ?? readString(props.country_code),
  );
  if (fromV6) return fromV6;

  const ctxList = Array.isArray(feature.context) ? feature.context : Array.isArray(props.context) ? props.context : [];
  for (const row of ctxList) {
    if (!row || typeof row !== "object") continue;
    const item = row as Record<string, unknown>;
    const id = readString(item.id) ?? "";
    if (id.startsWith("country.")) {
      const iso = normalizeIsoCountryCode(id.slice("country.".length));
      if (iso) return iso;
    }
    const short = normalizeIsoCountryCode(readString(item.short_code));
    if (short) return short;
  }
  return null;
}

function extractCity(feature: Record<string, unknown>): string | null {
  const props = (feature.properties && typeof feature.properties === "object"
    ? feature.properties
    : {}) as Record<string, unknown>;
  const context = (props.context && typeof props.context === "object"
    ? props.context
    : {}) as Record<string, unknown>;
  for (const key of ["place", "locality", "district", "region"]) {
    const node = context[key];
    if (node && typeof node === "object") {
      const name = readString((node as Record<string, unknown>).name);
      if (name) return name;
    }
  }
  return readString(props.name);
}

function featureToResult(feature: Record<string, unknown>): CorporateGeocodeResult | null {
  const geometry = (feature.geometry && typeof feature.geometry === "object"
    ? feature.geometry
    : {}) as Record<string, unknown>;
  const coords = Array.isArray(geometry.coordinates) ? geometry.coordinates : [];
  const lng = Number(coords[0]);
  const lat = Number(coords[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const countryCode = extractCountryCode(feature);
  if (!countryCode) return null;
  const props = (feature.properties && typeof feature.properties === "object"
    ? feature.properties
    : {}) as Record<string, unknown>;
  return {
    countryCode,
    latitude: lat,
    longitude: lng,
    formattedAddress:
      readString(props.full_address) ??
      readString(props.place_formatted) ??
      readString(props.name),
    city: extractCity(feature),
  };
}

/**
 * Forward-geocode a company address or postcode with no country bias.
 * Country comes from the geocoder (ISO), never from a hardcoded city list.
 */
export async function geocodeCorporateAddress(
  address: string,
): Promise<CorporateGeocodeResult | null> {
  const query = address.trim();
  if (query.length < 2) return null;
  const token = Deno.env.get("MAPBOX_ACCESS_TOKEN");
  if (!token) {
    console.error("[corporateAddressGeocode] MAPBOX_ACCESS_TOKEN missing");
    return null;
  }

  const url =
    `https://api.mapbox.com/search/geocode/v6/forward?q=${encodeURIComponent(query)}` +
    `&limit=1&language=en&access_token=${token}`;
  const res = await mbFetch(url);
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || typeof data !== "object") {
    console.error("[corporateAddressGeocode] mapbox error", res.status);
    return null;
  }
  const features = Array.isArray((data as Record<string, unknown>).features)
    ? (data as { features: unknown[] }).features
    : [];
  const feature = features[0];
  if (!feature || typeof feature !== "object") return null;
  return featureToResult(feature as Record<string, unknown>);
}
