/**
 * Trip action location evidence — read model for the immutable GPS proof
 * captured by the database when a driver taps Arrived, No-show, or ends a trip.
 */
export type TripLocationEvidenceAction = 'arrived_pickup' | 'no_show' | 'trip_completed';

export interface TripLocationEvidence {
  id: string;
  trip_id: string;
  driver_id: string | null;
  action: TripLocationEvidenceAction;
  recorded_at: string;
  driver_lat: number | null;
  driver_lng: number | null;
  driver_location_source: string | null;
  driver_location_at: string | null;
  driver_location_age_seconds: number | null;
  driver_accuracy_m: number | null;
  target_type: string | null;
  target_lat: number | null;
  target_lng: number | null;
  distance_to_target_m: number | null;
  passenger_lat: number | null;
  passenger_lng: number | null;
  passenger_location_at: string | null;
  passenger_accuracy_m: number | null;
}

/** A GPS fix older than this when the button was tapped is flagged as stale. */
export const EVIDENCE_STALE_AFTER_SECONDS = 120;

export const EVIDENCE_ACTION_ORDER: TripLocationEvidenceAction[] = [
  'arrived_pickup',
  'no_show',
  'trip_completed',
];

export const EVIDENCE_ACTION_META: Record<
  TripLocationEvidenceAction,
  { label: string; marker: string; color: string; targetLabel: string }
> = {
  arrived_pickup: { label: 'Driver tapped Arrived at pickup', marker: 'A', color: '#f59e0b', targetLabel: 'pickup' },
  no_show: { label: 'Driver tapped No-show', marker: 'N', color: '#a855f7', targetLabel: 'pickup' },
  trip_completed: { label: 'Driver ended the trip', marker: 'E', color: '#0ea5e9', targetLabel: 'drop-off' },
};

export const PASSENGER_MARKER_COLOR = '#ec4899';

export function sortEvidence(rows: TripLocationEvidence[]): TripLocationEvidence[] {
  return [...rows].sort(
    (a, b) => EVIDENCE_ACTION_ORDER.indexOf(a.action) - EVIDENCE_ACTION_ORDER.indexOf(b.action),
  );
}

export type EvidenceFreshness = 'fresh' | 'stale' | 'missing';

export function evidenceFreshness(row: Pick<TripLocationEvidence, 'driver_lat' | 'driver_lng' | 'driver_location_age_seconds'>): EvidenceFreshness {
  if (row.driver_lat == null || row.driver_lng == null) return 'missing';
  if (row.driver_location_age_seconds == null) return 'stale';
  return row.driver_location_age_seconds > EVIDENCE_STALE_AFTER_SECONDS ? 'stale' : 'fresh';
}

export function formatEvidenceDistance(meters: number | null | undefined): string {
  if (meters == null || !Number.isFinite(meters)) return '—';
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(2)} km`;
}

export function formatEvidenceAge(seconds: number | null | undefined): string {
  if (seconds == null) return 'unknown age';
  if (seconds < 60) return `${seconds}s before tap`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return `${m}m ${s}s before tap`;
  return `${Math.floor(m / 60)}h ${m % 60}m before tap`;
}

export function googleMapsPointUrl(lat: number, lng: number): string {
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
}
