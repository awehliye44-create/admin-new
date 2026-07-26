/**
 * Minimal trip display-fare SSOT for Edge Functions.
 * Prefer payable/final fields; never invent commission.
 */

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const x = Number(v);
    return Number.isFinite(x) ? x : null;
  }
  return null;
}

export type TripDisplayFare = {
  payable_pence: number;
  payable_major: number;
  source: string;
};

export function resolveTripDisplayFare(
  trip: Record<string, unknown>,
): TripDisplayFare {
  const candidates: Array<{ pence: number | null; source: string }> = [
    { pence: num(trip.payable_fare_pence), source: "payable_fare_pence" },
    { pence: num(trip.final_fare_pence), source: "final_fare_pence" },
    { pence: num(trip.gross_fare_pence), source: "gross_fare_pence" },
    { pence: num(trip.estimated_total_pence), source: "estimated_total_pence" },
  ];

  for (const c of candidates) {
    if (c.pence != null && c.pence > 0) {
      return {
        payable_pence: Math.round(c.pence),
        payable_major: Math.round(c.pence) / 100,
        source: c.source,
      };
    }
  }

  const major = num(trip.fare) ?? num(trip.estimated_fare);
  if (major != null && major > 0) {
    const pence = Math.round(major * 100);
    return { payable_pence: pence, payable_major: major, source: "major_fare" };
  }

  return { payable_pence: 0, payable_major: 0, source: "missing" };
}
