/** Driver signup country detection SSOT. */

export type DriverSignupDetectionSource = "gps" | "ip" | "phone" | "none";

export function normalizeSignupCountryCode(raw: string | null | undefined): string | null {
  const v = String(raw ?? "").trim().toUpperCase();
  if (!v || v.length !== 2) return null;
  return v;
}

export function phoneDialToIsoCountry(dial: string | null | undefined): string | null {
  const d = String(dial ?? "").replace(/\D/g, "");
  if (d === "44" || d === "0044") return "GB";
  if (d === "1") return "US";
  return null;
}

export function guessCountryFromCoordinates(
  lat: number,
  lng: number,
): string | null {
  // UK bounding-box heuristic only — signup suggestion, not authoritative.
  if (lat >= 49.5 && lat <= 61.0 && lng >= -8.5 && lng <= 2.0) return "GB";
  return null;
}

export function resolveDetectionSource(args: {
  hasGps: boolean;
  hasIpCountry: boolean;
  hasPhoneCountry: boolean;
}): DriverSignupDetectionSource {
  if (args.hasGps) return "gps";
  if (args.hasIpCountry) return "ip";
  if (args.hasPhoneCountry) return "phone";
  return "none";
}
