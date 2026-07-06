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
 * Deep-link to Financial Reconciliation → Trips tab with payment action drawer.
 */
export function financeReconciliationTripUrl(tripId: string, tripCode?: string | null): string {
  const params = new URLSearchParams({ tab: 'trips', recover: '1' });
  if (tripCode?.trim()) {
    params.set('trip', tripCode.trim());
  } else {
    params.set('tripId', tripId);
  }
  return `/financial-reconciliation?${params.toString()}`;
}

/** Read-only platform finance audit — per-trip commission / Provider fees live here, not Trip History. */
export function financialReconciliationTripsTabUrl(tripId: string, tripCode?: string | null): string {
  const params = new URLSearchParams({ tab: 'trips' });
  if (tripCode?.trim()) {
    params.set('trip', tripCode.trim());
  } else {
    params.set('tripId', tripId);
  }
  const qs = params.toString();
  return `/financial-reconciliation?${qs}`;
}
