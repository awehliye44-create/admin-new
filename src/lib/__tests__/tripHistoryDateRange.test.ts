import { describe, expect, it } from 'vitest';
import {
  resolveTripHistoryDateRange,
  tripHistoryDateFilterForSort,
} from '../tripHistoryDateRange';

const NOW = new Date('2026-11-21T08:00:00.000Z');

describe('Trip History date range', () => {
  it('All Time reaches trips from years ago (oldest trip is July 2026)', () => {
    const { start } = resolveTripHistoryDateRange('all', '', '', NOW);
    expect(start.getTime()).toBeLessThan(new Date('2026-07-08T00:00:00Z').getTime());
  });

  it('Custom Range with no dates picked covers all time, not just the last 7 days', () => {
    const { start } = resolveTripHistoryDateRange('custom', '', '', NOW);
    expect(start.getTime()).toBeLessThan(new Date('2026-07-08T00:00:00Z').getTime());
  });

  it('Choosing Oldest first on Last 7 Days widens to All Time', () => {
    expect(tripHistoryDateFilterForSort('oldest', '7days')).toBe('all');
    expect(tripHistoryDateFilterForSort('oldest', 'today')).toBe('all');
  });

  it('Choosing Oldest first keeps a Custom Range the admin picked', () => {
    expect(tripHistoryDateFilterForSort('oldest', 'custom')).toBe('custom');
  });

  it('Choosing Newest first leaves the range unchanged', () => {
    expect(tripHistoryDateFilterForSort('newest', '7days')).toBe('7days');
  });
});
