import { describe, expect, it } from 'vitest';
import {
  filterAdminActiveTrips,
  isAdminStaleSearchingTrip,
} from '@/lib/adminActiveTripFilter';

describe('adminActiveTripFilter', () => {
  const now = Date.parse('2030-06-05T12:00:00.000Z');

  it('excludes searching trips past searching_expires_at', () => {
    const trips = [
      {
        trip_code: 'MK-260605-024',
        status: 'searching',
        searching_expires_at: '2030-06-05T11:57:00.000Z',
        driver_id: null,
      },
      {
        trip_code: 'MK-260605-099',
        status: 'searching',
        searching_expires_at: '2030-06-05T12:05:00.000Z',
        driver_id: null,
      },
      {
        trip_code: 'MK-260605-100',
        status: 'driver_en_route',
        searching_expires_at: '2030-06-05T11:00:00.000Z',
        driver_id: 'driver-1',
      },
    ];

    const filtered = filterAdminActiveTrips(trips, now);
    expect(filtered.map((t) => t.trip_code)).toEqual(['MK-260605-099', 'MK-260605-100']);
  });

  it('keeps assigned trips even with past searching_expires_at', () => {
    expect(
      isAdminStaleSearchingTrip(
        {
          status: 'searching',
          searching_expires_at: '2020-01-01T00:00:00.000Z',
          driver_id: 'driver-1',
        },
        now,
      ),
    ).toBe(false);
  });

  it('does not exclude in-progress trips', () => {
    const trips = [
      { trip_code: 'MK-1', status: 'in_progress', driver_id: 'd1' },
      { trip_code: 'MK-2', status: 'arrived_pickup', driver_id: 'd2' },
    ];
    expect(filterAdminActiveTrips(trips, now)).toHaveLength(2);
  });
});
