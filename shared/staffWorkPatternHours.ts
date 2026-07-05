export type WeekdayKey = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

export type ShiftLengthPreset = '8h' | '10h' | '12h' | 'night_12h' | 'custom';

export type ShiftType = 'day' | 'late' | 'night' | 'morning' | 'off';

export interface DaySchedule {
  day: WeekdayKey;
  enabled: boolean;
  start_time: string;
  end_time: string;
  break_minutes: number;
  shift_type: ShiftType;
}

export const WEEKDAY_KEYS: WeekdayKey[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

export const WEEKDAY_LABELS: Record<WeekdayKey, string> = {
  mon: 'Mon',
  tue: 'Tue',
  wed: 'Wed',
  thu: 'Thu',
  fri: 'Fri',
  sat: 'Sat',
  sun: 'Sun',
};

export const SHIFT_LENGTH_PRESETS: Record<
  Exclude<ShiftLengthPreset, 'custom'>,
  { start_time: string; end_time: string; break_minutes: number }
> = {
  '8h': { start_time: '08:00', end_time: '16:00', break_minutes: 60 },
  '10h': { start_time: '08:00', end_time: '18:00', break_minutes: 60 },
  '12h': { start_time: '07:00', end_time: '19:00', break_minutes: 60 },
  night_12h: { start_time: '19:00', end_time: '07:00', break_minutes: 60 },
};

export function parseTimeToMinutes(time: string): number {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

/** Daily working minutes after break; handles shifts crossing midnight. */
export function calculateDailyMinutes(
  startTime: string,
  endTime: string,
  breakMinutes: number,
): number {
  let start = parseTimeToMinutes(startTime);
  let end = parseTimeToMinutes(endTime);
  if (end <= start) {
    end += 24 * 60;
  }
  return Math.max(0, end - start - breakMinutes);
}

export function calculateWeeklyMinutes(schedule: DaySchedule[]): number {
  return schedule
    .filter((day) => day.enabled)
    .reduce(
      (total, day) =>
        total + calculateDailyMinutes(day.start_time, day.end_time, day.break_minutes),
      0,
    );
}

export function formatMinutesAsHours(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}h ${String(mins).padStart(2, '0')}m`;
}

export function defaultDaySchedule(day: WeekdayKey, enabled: boolean): DaySchedule {
  const preset = SHIFT_LENGTH_PRESETS['8h'];
  return {
    day,
    enabled,
    start_time: preset.start_time,
    end_time: preset.end_time,
    break_minutes: preset.break_minutes,
    shift_type: 'day',
  };
}

export function buildDefaultSchedule(weekdaysOnly = true): DaySchedule[] {
  return WEEKDAY_KEYS.map((day) =>
    defaultDaySchedule(day, weekdaysOnly ? day !== 'sat' && day !== 'sun' : false),
  );
}

export function applyShiftLengthPreset(
  schedule: DaySchedule[],
  preset: ShiftLengthPreset,
): DaySchedule[] {
  if (preset === 'custom') return schedule;
  const times = SHIFT_LENGTH_PRESETS[preset];
  return schedule.map((day) =>
    day.enabled
      ? {
          ...day,
          start_time: times.start_time,
          end_time: times.end_time,
          break_minutes: times.break_minutes,
          shift_type: preset === 'night_12h' ? 'night' : day.shift_type,
        }
      : day,
  );
}

export function summarizeWorkingDays(schedule: DaySchedule[]): string {
  const enabled = schedule.filter((d) => d.enabled);
  if (enabled.length === 0) return 'None';
  const labels = enabled.map((d) => WEEKDAY_LABELS[d.day]);
  if (labels.length <= 3) return labels.join(', ');
  return `${labels[0]} – ${labels[labels.length - 1]}`;
}

export function shiftLengthLabel(preset: ShiftLengthPreset): string {
  switch (preset) {
    case '8h':
      return '8-hour';
    case '10h':
      return '10-hour';
    case '12h':
      return '12-hour';
    case 'night_12h':
      return 'Night 12-hour';
    default:
      return 'Custom';
  }
}
