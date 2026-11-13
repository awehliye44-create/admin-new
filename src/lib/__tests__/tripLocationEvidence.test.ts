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
