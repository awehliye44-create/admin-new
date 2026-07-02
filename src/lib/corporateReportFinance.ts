export const COUNTABLE_CORPORATE_FINANCIAL_OUTCOMES = [
  'COMPLETED',
  'NO_SHOW',
  'LATE_PASSENGER_CANCELLATION',
] as const;

export type CorporateReportTripRow = {
  id: string;
  created_at: string;
  status?: string;
  corporate_account_id?: string | null;
  corporate_account?: { id: string; company_name: string } | null;
  financial_outcome?: string | null;
};

export function isCountableCorporateFinancialTrip(trip: { financial_outcome?: string | null }): boolean {
  return COUNTABLE_CORPORATE_FINANCIAL_OUTCOMES.includes(
    (trip.financial_outcome || '') as (typeof COUNTABLE_CORPORATE_FINANCIAL_OUTCOMES)[number],
  );
}

export function calculateMonthlyTripTrends(trips: CorporateReportTripRow[]) {
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthData: Record<string, number> = {};

  for (const trip of trips) {
    const date = new Date(trip.created_at);
    const key = `${date.getFullYear()}-${String(date.getMonth()).padStart(2, '0')}`;
    monthData[key] = (monthData[key] ?? 0) + 1;
  }

  return Object.entries(monthData)
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-6)
    .map(([key, tripsCount]) => ({
      month: monthNames[parseInt(key.split('-')[1], 10)],
      trips: tripsCount,
    }));
}
