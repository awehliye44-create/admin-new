/**
 * Edge-local trip display fare SSOT.
 * Previously re-exported a missing packages/onecab-shared path which broke
 * `supabase functions deploy restore-active-trip`.
 */

export type TripDisplayFareResult = {
  payable_pence: number;
  payable_major: number;
  source: string;
};

function nonNegInt(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/**
 * Resolve customer-visible payable fare from trip row fields (pence).
 * Prefer locked / accepted / estimated totals — never invent discounts.
 */
export function resolveTripDisplayFare(
  trip: Record<string, unknown> | null | undefined,
): TripDisplayFareResult {
  const row = trip ?? {};

  const candidates: Array<{ pence: number; source: string }> = [
    { pence: nonNegInt(row.final_customer_fare_pence), source: "final_customer_fare_pence" },
    { pence: nonNegInt(row.final_fare_pence), source: "final_fare_pence" },
    { pence: nonNegInt(row.accepted_preset_offer_fare_pence), source: "accepted_preset_offer_fare_pence" },
    { pence: nonNegInt(row.accepted_driver_offer_fare_pence), source: "accepted_driver_offer_fare_pence" },
    { pence: nonNegInt(row.locked_base_fare_pence), source: "locked_base_fare_pence" },
    { pence: nonNegInt(row.estimated_total_pence), source: "estimated_total_pence" },
    { pence: nonNegInt(row.quoted_fare_pence), source: "quoted_fare_pence" },
    {
      pence: nonNegInt(row.estimated_fare) > 0 && nonNegInt(row.estimated_fare) < 1000
        ? Math.round(nonNegInt(row.estimated_fare) * 100)
        : nonNegInt(row.estimated_fare),
      source: "estimated_fare",
    },
  ];

  for (const candidate of candidates) {
    if (candidate.pence > 0) {
      return {
        payable_pence: candidate.pence,
        payable_major: candidate.pence / 100,
        source: candidate.source,
      };
    }
  }

  return { payable_pence: 0, payable_major: 0, source: "unresolved" };
}
