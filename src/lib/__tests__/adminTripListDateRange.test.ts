import { describe, expect, it } from 'vitest';
import {
  ADMIN_TRIP_PRESET_DATE_FILTER_OPTIONS,
  resolveAdminTripDateRange,
  adminTripDateFilterForSort,
} from '../adminTripListDateRange';

const NOW = new Date('2026-11-21T08:00:00.000Z');

describe('Admin trip list date range', () => {
  it('All Time reaches trips from years ago (oldest trip is July 2026)', () => {
    const { start } = resolveAdminTripDateRange('all', '', '', NOW);
    expect(start.getTime()).toBeLessThan(new Date('2026-07-08T00:00:00Z').getTime());
  });

  it('Custom Range with no dates picked covers all time, not just the last 7 days', () => {
    const { start } = resolveAdminTripDateRange('custom', '', '', NOW);
    expect(start.getTime()).toBeLessThan(new Date('2026-07-08T00:00:00Z').getTime());
  });

  it('Choosing Oldest first on Last 7 Days widens to All Time', () => {
    expect(adminTripDateFilterForSort('oldest', '7days')).toBe('all');
    expect(adminTripDateFilterForSort('oldest', 'today')).toBe('all');
  });

  it('Choosing Oldest first keeps a Custom Range the admin picked', () => {
    expect(adminTripDateFilterForSort('oldest', 'custom')).toBe('custom');
  });

  it('Missed & Cancelled offers All Time (no Custom Range pickers there)', () => {
    const values = ADMIN_TRIP_PRESET_DATE_FILTER_OPTIONS.map((o) => o.value);
    expect(values).toContain('all');
    expect(values).not.toContain('custom');
  });

  it('Choosing Newest first leaves the range unchanged', () => {
    expect(adminTripDateFilterForSort('newest', '7days')).toBe('7days');
  });
});
