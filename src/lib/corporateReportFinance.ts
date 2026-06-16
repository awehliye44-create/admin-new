import {
  getServiceAreaTripCustomerPaidPence,
  getServiceAreaTripDriverNetPence,
  type ServiceAreaTripFinanceContext,
  type ServiceAreaTripFinanceRow,
} from '@/lib/serviceAreaTripFinance';

export const COUNTABLE_CORPORATE_FINANCIAL_OUTCOMES = [
  'COMPLETED',
  'NO_SHOW',
  'LATE_PASSENGER_CANCELLATION',
] as const;

export type CorporateReportTripRow = ServiceAreaTripFinanceRow & {
  id: string;
  created_at: string;
  status: string;
  corporate_account_id?: string | null;
  corporate_account?: { id: string; company_name: string } | null;
  commission_pence?: number | null;
  financial_outcome?: string | null;
};

export type EnrichedCorporateReportTrip = CorporateReportTripRow & {
  customerPaidPence: number;
  driverNetPence: number | null;
};

export function buildCorporateTripFinanceContext(
  tripId: string,
  paymentsByTripId: ReadonlyMap<string, number>,
  ledgerNetByTripId: ReadonlyMap<string, number>,
): ServiceAreaTripFinanceContext {
  return {
    paymentCapturedPence: paymentsByTripId.get(tripId) ?? null,
    ledgerTripEarningNetPence: ledgerNetByTripId.get(tripId) ?? null,
  };
}

export function enrichCorporateReportTrip(
  trip: CorporateReportTripRow,
  paymentsByTripId: ReadonlyMap<string, number>,
  ledgerNetByTripId: ReadonlyMap<string, number>,
): EnrichedCorporateReportTrip {
  const context = buildCorporateTripFinanceContext(trip.id, paymentsByTripId, ledgerNetByTripId);
  return {
    ...trip,
    customerPaidPence: getServiceAreaTripCustomerPaidPence(trip, context),
    driverNetPence: getServiceAreaTripDriverNetPence(trip, context),
  };
}

export function isCountableCorporateFinancialTrip(trip: CorporateReportTripRow): boolean {
  return COUNTABLE_CORPORATE_FINANCIAL_OUTCOMES.includes(
    (trip.financial_outcome || '') as (typeof COUNTABLE_CORPORATE_FINANCIAL_OUTCOMES)[number],
  );
}

export function sumCustomerPaidPence(trips: EnrichedCorporateReportTrip[]): number {
  return trips.reduce((sum, trip) => sum + trip.customerPaidPence, 0);
}

export function sumDriverNetPence(trips: EnrichedCorporateReportTrip[]): number | null {
  if (trips.some((trip) => trip.driverNetPence == null)) return null;
  return trips.reduce((sum, trip) => sum + (trip.driverNetPence ?? 0), 0);
}

export function calculateMonthlySettlementTrends(trips: EnrichedCorporateReportTrip[]) {
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthData: Record<string, { trips: number; revenue: number }> = {};

  for (const trip of trips) {
    const date = new Date(trip.created_at);
    const key = `${date.getFullYear()}-${String(date.getMonth()).padStart(2, '0')}`;
    if (!monthData[key]) monthData[key] = { trips: 0, revenue: 0 };
    monthData[key].trips += 1;
    monthData[key].revenue += trip.customerPaidPence / 100;
  }

  return Object.entries(monthData)
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-6)
    .map(([key, data]) => ({
      month: monthNames[parseInt(key.split('-')[1], 10)],
      trips: data.trips,
      revenue: Math.round(data.revenue * 100) / 100,
    }));
}
