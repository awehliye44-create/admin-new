/** Deep-link to trip settlement / finance recovery (Trip History SSOT). */
export function tripSettlementRecoverUrl(tripId: string, tripCode?: string | null): string {
  const params = new URLSearchParams({ recover: '1' });
  if (tripCode?.trim()) {
    params.set('trip', tripCode.trim());
  } else {
    params.set('tripId', tripId);
  }
  return `/trip-history?${params.toString()}`;
}

/**
 * Legacy FR → Trips deep links redirect to trip-history recover via FinancialReconciliation page.
 * Use for capture recovery / settlement actions.
 */
export function financeReconciliationTripUrl(tripId: string, tripCode?: string | null): string {
  const params = new URLSearchParams({ recover: '1' });
  if (tripCode?.trim()) {
    params.set('trip', tripCode.trim());
  } else {
    params.set('tripId', tripId);
  }
  return `/financial-reconciliation?${params.toString()}`;
}

/** Read-only platform finance audit — per-trip commission / Stripe fees live here, not Trip History. */
export function financialReconciliationTripsTabUrl(tripId: string, tripCode?: string | null): string {
  const params = new URLSearchParams();
  if (tripCode?.trim()) {
    params.set('trip', tripCode.trim());
  } else {
    params.set('tripId', tripId);
  }
  const qs = params.toString();
  return qs ? `/financial-reconciliation?${qs}` : '/financial-reconciliation';
}
