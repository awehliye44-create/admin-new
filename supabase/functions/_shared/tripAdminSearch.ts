export const TRIP_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const NO_MATCH_TRIP_ID = "00000000-0000-0000-0000-000000000000";

export function isTripUuid(value: string): boolean {
  return TRIP_UUID_RE.test(value.trim());
}

export function escapePostgrestFilter(value: string): string {
  return value.replace(/[%_,]/g, "");
}

export function tripCodeRouteOrFilter(term: string): string {
  const safe = escapePostgrestFilter(term);
  return `trip_code.ilike.%${safe}%,trip_number.ilike.%${safe}%,pickup_address.ilike.%${safe}%,dropoff_address.ilike.%${safe}%`;
}

export function tripCodeOrFilter(term: string): string {
  const safe = escapePostgrestFilter(term);
  return `trip_code.ilike.%${safe}%,trip_number.ilike.%${safe}%`;
}
