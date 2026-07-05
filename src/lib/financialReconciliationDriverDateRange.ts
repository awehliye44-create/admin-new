import {
  endOfDay,
  endOfMonth,
  endOfWeek,
  format,
  startOfDay,
  startOfMonth,
  startOfWeek,
  subWeeks,
} from 'date-fns';

export type DriverDateRangePreset =
  | 'today'
  | 'current_week'
  | 'last_week'
  | 'current_month'
  | 'custom';

export type DriverDateRange = {
  preset: DriverDateRangePreset;
  from: string;
  to: string;
};

const ISO = 'yyyy-MM-dd';

export function resolveDriverDateRange(preset: DriverDateRangePreset, custom?: { from: string; to: string }): DriverDateRange {
  const now = new Date();
  if (preset === 'today') {
    const d = format(now, ISO);
    return { preset, from: d, to: d };
  }
  if (preset === 'current_week') {
    const start = startOfWeek(now, { weekStartsOn: 1 });
    return {
      preset,
      from: format(start, ISO),
      to: format(endOfWeek(now, { weekStartsOn: 1 }), ISO),
    };
  }
  if (preset === 'last_week') {
    const lastWeek = subWeeks(now, 1);
    const start = startOfWeek(lastWeek, { weekStartsOn: 1 });
    return {
      preset,
      from: format(start, ISO),
      to: format(endOfWeek(lastWeek, { weekStartsOn: 1 }), ISO),
    };
  }
  if (preset === 'current_month') {
    return {
      preset,
      from: format(startOfMonth(now), ISO),
      to: format(endOfMonth(now), ISO),
    };
  }
  return {
    preset: 'custom',
    from: custom?.from ?? format(startOfWeek(now, { weekStartsOn: 1 }), ISO),
    to: custom?.to ?? format(endOfWeek(now, { weekStartsOn: 1 }), ISO),
  };
}

export function defaultDriverDateRange(): DriverDateRange {
  return resolveDriverDateRange('current_week');
}

export function tripDateInRange(iso: string | null | undefined, from: string, to: string): boolean {
  if (!iso) return false;
  const day = format(new Date(iso), ISO);
  return day >= from && day <= to;
}

export function driverDateRangeLabel(range: DriverDateRange): string {
  if (range.preset === 'today') return 'Today';
  if (range.preset === 'current_week') return 'Current week';
  if (range.preset === 'last_week') return 'Last week';
  if (range.preset === 'current_month') return 'Current month';
  return `${range.from} → ${range.to}`;
}
