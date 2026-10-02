export const KM_PER_MILE = 1.609344;

export function isMilesDistanceUnit(distanceUnit: string | null | undefined): boolean {
  return String(distanceUnit || "km").toLowerCase().startsWith("mi");
}

export function metersToDisplayDistance(
  distanceMeters: number,
  distanceUnit: string | null | undefined,
): number {
  const km = distanceMeters / 1000;
  return isMilesDistanceUnit(distanceUnit) ? km / KM_PER_MILE : km;
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  GBP: "£",
  USD: "$",
  EUR: "€",
  KES: "KSh",
  NGN: "₦",
  ZAR: "R",
  INR: "₹",
  AED: "AED",
  CAD: "CA$",
  AUD: "A$",
  IDR: "Rp",
};

export function currencySymbolForCode(currencyCode: string): string {
  const code = (currencyCode || "").toUpperCase();
  return CURRENCY_SYMBOLS[code] || `${code} `;
}
