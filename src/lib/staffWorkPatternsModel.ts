import type { StaffRole } from '@/hooks/useStaffProfile';
import type { DaySchedule, ShiftLengthPreset } from '../../shared/staffWorkPatternHours';
import { WEEKDAY_KEYS } from '../../shared/staffWorkPatternHours';

export type StaffWorkPatternType = 'fixed_weekly' | 'rotating' | 'custom';

export type PatternBadge = 'assigned' | 'open' | 'inactive';

export interface StaffWorkPatternRow {
  id: string;
  name: string;
  pattern_type: StaffWorkPatternType;
  timezone: string;
  description: string | null;
  shift_length_preset: ShiftLengthPreset;
  schedule: DaySchedule[];
  weekly_hours_minutes: number;
  staff_role: StaffRole | null;
  region_id: string | null;
  service_area_id: string | null;
  is_active: boolean;
  effective_from: string | null;
  effective_to: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  region_name?: string | null;
  service_area_name?: string | null;
  assigned_staff_count: number;
  badge: PatternBadge;
}

export interface PatternDashboardStats {
  total: number;
  assigned: number;
  open: number;
  inactive: number;
}

export interface CoverageRequirementRow {
  id: string;
  shift_name: string;
  staff_role: StaffRole;
  day_of_week: number;
  start_time: string;
  end_time: string;
  required_staff_count: number;
  region_id: string | null;
  service_area_id: string | null;
  region_name?: string | null;
  service_area_name?: string | null;
}

export interface CoverageGapRow extends CoverageRequirementRow {
  scheduled_staff_count: number;
  coverage_gap: number;
  has_gap: boolean;
}

export interface StaffWithPattern {
  id: string;
  staff_role_id: string;
  full_name: string;
  role: StaffRole;
  is_active: boolean;
  assigned_pattern_id: string | null;
  pattern_name: string | null;
  region_name: string | null;
  service_area_names: string[];
  weekly_hours_minutes: number | null;
}

export function countAssignedStaffForPattern(
  patternId: string,
  junctionAssignments: { pattern_id: string; staff_id: string; is_active: boolean }[],
  staffProfiles: { id: string; assigned_pattern_id: string | null; is_active?: boolean }[],
): number {
  const staffIds = new Set<string>();
  for (const assignment of junctionAssignments) {
    if (assignment.pattern_id === patternId && assignment.is_active) {
      staffIds.add(assignment.staff_id);
    }
  }
  for (const profile of staffProfiles) {
    if (profile.assigned_pattern_id === patternId && profile.is_active !== false) {
      staffIds.add(profile.id);
    }
  }
  return staffIds.size;
}

/** Open when active and zero staff linked via assignments or assigned_pattern_id. */
export function isOpenPattern(isActive: boolean, assignedStaffCount: number): boolean {
  return isActive && assignedStaffCount <= 0;
}

export function resolvePatternBadge(
  isActive: boolean,
  assignedStaffCount: number,
): PatternBadge {
  if (!isActive) return 'inactive';
  if (isOpenPattern(isActive, assignedStaffCount)) return 'open';
  return 'assigned';
}

export function patternHasCoverageGap(
  pattern: StaffWorkPatternRow,
  gaps: CoverageGapRow[],
): boolean {
  if (pattern.badge !== 'assigned' || !pattern.is_active) return false;
  return gaps.some((gap) => {
    if (!gap.has_gap) return false;
    if (pattern.staff_role && pattern.staff_role !== gap.staff_role) return false;
    return pattern.schedule.some(
      (day) =>
        day.enabled &&
        WEEKDAY_KEYS[gap.day_of_week] === day.day &&
        scheduleCoversRequirement(pattern.schedule, gap.day_of_week, gap.start_time, gap.end_time),
    );
  });
}

export function computePatternDashboardStats(
  patterns: Pick<StaffWorkPatternRow, 'is_active' | 'assigned_staff_count'>[],
): PatternDashboardStats {
  let assigned = 0;
  let open = 0;
  let inactive = 0;

  for (const pattern of patterns) {
    if (!pattern.is_active) {
      inactive += 1;
      continue;
    }
    if (pattern.assigned_staff_count > 0) {
      assigned += 1;
    } else {
      open += 1;
    }
  }

  return {
    total: patterns.length,
    assigned,
    open,
    inactive,
  };
}

function parseTimeToMinutes(time: string): number {
  const normalized = time.length === 5 ? time : time.slice(0, 5);
  const [hours, minutes] = normalized.split(':').map(Number);
  return hours * 60 + minutes;
}

function scheduleCoversRequirement(
  schedule: DaySchedule[],
  dayOfWeek: number,
  reqStart: string,
  reqEnd: string,
): boolean {
  const dayKey = WEEKDAY_KEYS[dayOfWeek];
  const day = schedule.find((entry) => entry.day === dayKey);
  if (!day?.enabled) return false;

  let start = parseTimeToMinutes(day.start_time);
  let end = parseTimeToMinutes(day.end_time);
  let reqStartM = parseTimeToMinutes(reqStart);
  let reqEndM = parseTimeToMinutes(reqEnd);

  if (end <= start) end += 24 * 60;
  if (reqEndM <= reqStartM) reqEndM += 24 * 60;

  return start <= reqStartM && end >= reqEndM;
}

export function computeCoverageGaps(
  requirements: CoverageRequirementRow[],
  patterns: StaffWorkPatternRow[],
  assignments: { pattern_id: string; staff_id: string; is_active: boolean }[],
): CoverageGapRow[] {
  const activeAssignments = assignments.filter((row) => row.is_active);
  const patternById = new Map(patterns.map((pattern) => [pattern.id, pattern]));

  return requirements.map((requirement) => {
    const matchingStaffIds = new Set<string>();

    for (const assignment of activeAssignments) {
      const pattern = patternById.get(assignment.pattern_id);
      if (!pattern || !pattern.is_active || pattern.archived_at) continue;
      if (pattern.assigned_staff_count <= 0) continue;
      if (pattern.staff_role && pattern.staff_role !== requirement.staff_role) continue;
      if (requirement.region_id && pattern.region_id !== requirement.region_id) continue;
      if (
        requirement.service_area_id &&
        pattern.service_area_id &&
        pattern.service_area_id !== requirement.service_area_id
      ) {
        continue;
      }
      if (
        !scheduleCoversRequirement(
          pattern.schedule,
          requirement.day_of_week,
          requirement.start_time,
          requirement.end_time,
        )
      ) {
        continue;
      }
      matchingStaffIds.add(assignment.staff_id);
    }

    const scheduled = matchingStaffIds.size;
    const coverage_gap = requirement.required_staff_count - scheduled;

    return {
      ...requirement,
      scheduled_staff_count: scheduled,
      coverage_gap,
      has_gap: coverage_gap > 0,
    };
  });
}

export function coverageGapMessage(gap: number): string {
  if (gap <= 0) return 'Coverage met';
  return `Coverage gap: ${gap} staff missing`;
}

export const DAY_OF_WEEK_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export const PATTERN_TYPE_LABELS: Record<StaffWorkPatternType, string> = {
  fixed_weekly: 'Fixed Weekly',
  rotating: 'Rotating',
  custom: 'Custom',
};

export const INTERNAL_STAFF_ROLES: StaffRole[] = [
  'super_admin',
  'admin',
  'operator',
  'finance_manager',
  'customer_support',
  'compliance_officer',
];
