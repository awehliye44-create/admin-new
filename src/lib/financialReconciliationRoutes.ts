/** Deep-link to Financial Reconciliation → Trips for a single trip (read-only navigation). */
export function financialReconciliationTripsTabUrl(tripId: string, tripCode?: string | null): string {
  const params = new URLSearchParams({ tab: 'trips' });
  if (tripCode?.trim()) {
    params.set('trip', tripCode.trim());
  } else {
    params.set('tripId', tripId);
  }
  return `/financial-reconciliation?${params.toString()}`;
}
