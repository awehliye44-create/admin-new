import { describe, expect, it } from 'vitest';
import {
  buildDefaultSchedule,
  calculateWeeklyMinutes,
} from '../../../shared/staffWorkPatternHours';
import {
  computeCoverageGaps,
  computePatternDashboardStats,
  countAssignedStaffForPattern,
  coverageGapMessage,
  resolvePatternBadge,
  StaffWorkPatternRow,
} from '../staffWorkPatternsModel';

function makePattern(
  overrides: Partial<StaffWorkPatternRow> & Pick<StaffWorkPatternRow, 'id'>,
): StaffWorkPatternRow {
  return {
    name: 'Test',
    pattern_type: 'fixed_weekly',
    timezone: 'Europe/London',
    description: null,
    shift_length_preset: '8h',
    schedule: buildDefaultSchedule(true),
    weekly_hours_minutes: calculateWeeklyMinutes(buildDefaultSchedule(true)),
    staff_role: 'operator',
    region_id: null,
    service_area_id: null,
    is_active: true,
    effective_from: null,
    effective_to: null,
    archived_at: null,
    created_at: '',
    updated_at: '',
    assigned_staff_count: 0,
    badge: 'open',
    ...overrides,
  };
}

describe('staffWorkPatternsModel', () => {
  it('counts staff from junction table and assigned_pattern_id', () => {
    const count = countAssignedStaffForPattern(
      'pattern-1',
      [{ pattern_id: 'pattern-1', staff_id: 'staff-a', is_active: true }],
      [
        { id: 'staff-b', assigned_pattern_id: 'pattern-1', is_active: true },
        { id: 'staff-c', assigned_pattern_id: 'other', is_active: true },
      ],
    );
    expect(count).toBe(2);
  });

  it('marks active unassigned patterns as open', () => {
    expect(resolvePatternBadge(true, 0)).toBe('open');
    expect(resolvePatternBadge(true, 2)).toBe('assigned');
    expect(resolvePatternBadge(false, 0)).toBe('inactive');
  });

  it('aggregates dashboard stats', () => {
    const stats = computePatternDashboardStats([
      { is_active: true, assigned_staff_count: 2 },
      { is_active: true, assigned_staff_count: 0 },
      { is_active: false, assigned_staff_count: 0 },
    ]);
    expect(stats).toEqual({ total: 3, assigned: 1, open: 1, inactive: 1 });
  });

  it('excludes open patterns from scheduled coverage', () => {
    const openPattern = makePattern({ id: 'open', assigned_staff_count: 0 });
    const assignedPattern = makePattern({ id: 'assigned', assigned_staff_count: 1 });

    const gaps = computeCoverageGaps(
      [
        {
          id: 'req-1',
          shift_name: 'Day',
          staff_role: 'operator',
          day_of_week: 0,
          start_time: '08:00:00',
          end_time: '16:00:00',
          required_staff_count: 2,
          region_id: null,
          service_area_id: null,
        },
      ],
      [openPattern, assignedPattern],
      [
        { pattern_id: 'open', staff_id: 'staff-a', is_active: true },
        { pattern_id: 'assigned', staff_id: 'staff-b', is_active: true },
      ],
    );

    expect(gaps[0].scheduled_staff_count).toBe(1);
    expect(gaps[0].coverage_gap).toBe(1);
    expect(gaps[0].has_gap).toBe(true);
    expect(coverageGapMessage(gaps[0].coverage_gap)).toBe('Coverage gap: 1 staff missing');
  });
});
