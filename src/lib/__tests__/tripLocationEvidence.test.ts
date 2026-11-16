import { describe, it, expect } from 'vitest';
import {
  evidenceFreshness,
  formatEvidenceDistance,
  sortEvidence,
  EVIDENCE_STALE_AFTER_SECONDS,
  type TripLocationEvidence,
} from '../tripLocationEvidence';

const base = { driver_lat: 52.0, driver_lng: -0.7 };

describe('trip location evidence', () => {
  it('flags a GPS fix older than 2 minutes at tap time as stale', () => {
    expect(EVIDENCE_STALE_AFTER_SECONDS).toBe(120);
    expect(evidenceFreshness({ ...base, driver_location_age_seconds: 120 })).toBe('fresh');
    expect(evidenceFreshness({ ...base, driver_location_age_seconds: 121 })).toBe('stale');
  });

  it('reports missing when no driver position was available', () => {
    expect(evidenceFreshness({ driver_lat: null, driver_lng: null, driver_location_age_seconds: 5 })).toBe('missing');
  });

  it('shows distance in metres under 1 km and km above', () => {
    expect(formatEvidenceDistance(42.4)).toBe('42 m');
    expect(formatEvidenceDistance(4311.27)).toBe('4.31 km');
    expect(formatEvidenceDistance(null)).toBe('—');
  });

  it('orders events Arrived, No-show, Ended', () => {
    const rows = [{ action: 'trip_completed' }, { action: 'arrived_pickup' }, { action: 'no_show' }] as TripLocationEvidence[];
    expect(sortEvidence(rows).map((r) => r.action)).toEqual(['arrived_pickup', 'no_show', 'trip_completed']);
  });
});

import { legacyCompletionLocation } from '../tripLocationEvidence';

describe('older trips without location proof', () => {
  const drop = { dropoff_latitude: 52.0, dropoff_longitude: -0.7 };

  it('shows the trip end position when the driver ended 100 m or more from the drop-off', () => {
    const r = legacyCompletionLocation({ ...drop, driver_location_lat: 52.002, driver_location_lng: -0.7 }, []);
    expect(r).not.toBeNull();
    expect(Math.round(r!.distance_to_dropoff_m!)).toBe(222);
  });

  it('hides it when the driver ended within 100 m of the drop-off', () => {
    expect(legacyCompletionLocation({ ...drop, driver_location_lat: 52.0005, driver_location_lng: -0.7 }, [])).toBeNull();
  });

  it('hides it once a trip-ended proof row exists', () => {
    expect(
      legacyCompletionLocation({ ...drop, driver_location_lat: 52.01, driver_location_lng: -0.7 }, [{ action: 'trip_completed' }]),
    ).toBeNull();
  });
});
