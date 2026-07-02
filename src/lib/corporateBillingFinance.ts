import type { CorporateReportTripRow } from '@/lib/corporateReportFinance';

export type CorporateBillingTripStatus = string;

export type CorporateBillingTripRow = CorporateReportTripRow & {
  trip_number?: string | null;
  trip_code?: string | null;
  fare?: number | null;
  estimated_fare?: number | null;
  currency_code?: string | null;
  pickup_address?: string | null;
  dropoff_address?: string | null;
  waiting_charge_pence?: number | null;
  total_waiting_charge_pence?: number | null;
  completed_at?: string | null;
  fare_breakdown?: Record<string, number> | null;
};

export function getQuotedContractFareMajor(trip: {
  estimated_fare?: number | null;
  fare?: number | null;
}): number | null {
  if (trip.estimated_fare != null && trip.estimated_fare > 0) return trip.estimated_fare;
  if (trip.fare != null && trip.fare > 0) return trip.fare;
  return null;
}

export function formatDriverNetPence(
  pence: number | null,
  formatCurrency: (amount: number) => string,
): string {
  if (pence == null) return 'Unknown';
  return formatCurrency(pence / 100);
}
