/**
 * Payout schedule SSOT — single contract for display + scheduler.
 * Reads control-centre weekly_payout_day + payout_processing_time + timezone.
 * Never hardcodes Monday / 01:00 / browser-local math in UI.
 */

export const PAYOUT_WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

export type PayoutWeekday = (typeof PAYOUT_WEEKDAYS)[number];

export type PayoutScheduleStatus =
  | "ACTIVE"
  | "PAUSED"
  | "MANUAL_ONLY"
  | "MISCONFIGURED";

export type PayoutScheduleDto = {
  service_area_id: string | null;
  timezone: string;
  automatic_payouts_enabled: boolean;
  frequency: string;
  weekly_day: PayoutWeekday | string;
  local_processing_time: string;
  next_run_at_utc: string | null;
  next_run_at_local: string | null;
  schedule_label: string;
  schedule_status: PayoutScheduleStatus;
  schedule_version: string;
};

const WEEKDAY_TO_JS: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

const JS_TO_WEEKDAY = PAYOUT_WEEKDAYS;

export const PAYOUT_SCHEDULE_VERSION = "payout_schedule_ssot_v1";

/** Capitalise weekday for labels: tuesday → Tuesday */
export function titleCaseWeekday(day: string | null | undefined): string {
  const d = String(day ?? "").trim().toLowerCase();
  if (!d) return "—";
  return d.charAt(0).toUpperCase() + d.slice(1);
}

/**
 * Resolve IANA timezone for payout schedule.
 * UK GBP areas stored as bare "UTC" are treated as Europe/London (service-area local).
 */
export function resolvePayoutTimezone(args?: {
  serviceAreaTimezone?: string | null;
  currencyCode?: string | null;
  fallback?: string | null;
}): string {
  const raw = String(args?.serviceAreaTimezone ?? "").trim();
  const currency = String(args?.currencyCode ?? "").trim().toUpperCase();
  if (raw && raw !== "UTC" && raw !== "Etc/UTC" && raw !== "GMT") return raw;
  if (currency === "GBP" || !raw) {
    return String(args?.fallback ?? "Europe/London").trim() || "Europe/London";
  }
  return raw || "Europe/London";
}

export function buildPayoutScheduleLabel(args: {
  frequency?: string | null;
  weeklyDay?: string | null;
}): string {
  const freq = String(args.frequency ?? "weekly").toLowerCase();
  const day = titleCaseWeekday(args.weeklyDay ?? "monday");
  if (freq === "weekly") return `Weekly ${day}`;
  if (freq === "daily") return "Daily";
  if (freq === "fortnightly") return `Fortnightly ${day}`;
  if (freq === "monthly") return "Monthly";
  if (freq === "manual_only") return "Manual only";
  return `${titleCaseWeekday(freq)} ${day}`.trim();
}

function parseHm(raw: string | null | undefined): { hour: number; minute: number } {
  const m = String(raw ?? "12:00").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return { hour: 12, minute: 0 };
  const hour = Math.min(23, Math.max(0, Number(m[1])));
  const minute = Math.min(59, Math.max(0, Number(m[2])));
  return { hour, minute };
}

function zonedParts(date: Date, timeZone: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
} {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(date).filter((p) => p.type !== "literal").map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday ?? "Mon");
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: wd >= 0 ? wd : 1,
  };
}

/** Convert a wall-clock time in `timeZone` to a UTC Date (DST-safe via iterative offset). */
export function zonedWallTimeToUtc(args: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  timeZone: string;
}): Date {
  const { year, month, day, hour, minute, timeZone } = args;
  let guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  for (let i = 0; i < 4; i += 1) {
    const parts = zonedParts(new Date(guess), timeZone);
    const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    const desired = Date.UTC(year, month - 1, day, hour, minute, 0);
    const diff = asUtc - desired;
    if (diff === 0) break;
    guess -= diff;
  }
  return new Date(guess);
}

function addCalendarDays(year: number, month: number, day: number, add: number): {
  year: number;
  month: number;
  day: number;
} {
  const utc = new Date(Date.UTC(year, month - 1, day + add));
  return { year: utc.getUTCFullYear(), month: utc.getUTCMonth() + 1, day: utc.getUTCDate() };
}

/**
 * Next weekly run at local processing time in the given IANA timezone.
 * If today is the payout day and local time is still before processing time, use today.
 */
export function computeNextWeeklyPayoutRun(args: {
  weeklyPayoutDay?: string | null;
  localProcessingTime?: string | null;
  timeZone?: string | null;
  now?: Date;
}): {
  next_run_at_utc: string;
  next_run_at_local: string;
  weekly_day: string;
  local_processing_time: string;
  timezone: string;
} {
  const timeZone = String(args.timeZone ?? "Europe/London").trim() || "Europe/London";
  const weeklyDay = String(args.weeklyPayoutDay ?? "monday").trim().toLowerCase();
  const targetDow = WEEKDAY_TO_JS[weeklyDay] ?? 1;
  const { hour, minute } = parseHm(args.localProcessingTime);
  const localTime = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  const now = args.now ?? new Date();
  const nowParts = zonedParts(now, timeZone);

  let daysUntil = (targetDow - nowParts.weekday + 7) % 7;
  if (daysUntil === 0) {
    const nowMinutes = nowParts.hour * 60 + nowParts.minute;
    const targetMinutes = hour * 60 + minute;
    if (nowMinutes >= targetMinutes) daysUntil = 7;
  }

  const targetDate = addCalendarDays(nowParts.year, nowParts.month, nowParts.day, daysUntil);
  const utc = zonedWallTimeToUtc({
    year: targetDate.year,
    month: targetDate.month,
    day: targetDate.day,
    hour,
    minute,
    timeZone,
  });

  const localLabel = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(utc);

  return {
    next_run_at_utc: utc.toISOString(),
    next_run_at_local: `${localLabel} (${timeZone})`,
    weekly_day: JS_TO_WEEKDAY[targetDow] ?? weeklyDay,
    local_processing_time: localTime,
    timezone: timeZone,
  };
}

/** @deprecated Prefer computeNextWeeklyPayoutRun — kept for callers that only need an ISO instant. */
export function nextWeeklyPayoutDateIso(args?: {
  weeklyPayoutDay?: string | null;
  timeZone?: string | null;
  localProcessingTime?: string | null;
  now?: Date;
}): string {
  return computeNextWeeklyPayoutRun({
    weeklyPayoutDay: args?.weeklyPayoutDay,
    timeZone: args?.timeZone,
    localProcessingTime: args?.localProcessingTime ?? "12:00",
    now: args?.now,
  }).next_run_at_utc;
}

export function buildPayoutScheduleDto(args: {
  service_area_id?: string | null;
  timezone?: string | null;
  serviceAreaTimezone?: string | null;
  currencyCode?: string | null;
  automatic_payouts_enabled?: boolean;
  frequency?: string | null;
  weekly_day?: string | null;
  local_processing_time?: string | null;
  now?: Date;
}): PayoutScheduleDto {
  const timezone = resolvePayoutTimezone({
    serviceAreaTimezone: args.timezone ?? args.serviceAreaTimezone,
    currencyCode: args.currencyCode,
  });
  const frequency = String(args.frequency ?? "weekly").toLowerCase();
  const weekly_day = String(args.weekly_day ?? "monday").toLowerCase();
  const local_processing_time = parseHm(args.local_processing_time);
  const localTime = `${String(local_processing_time.hour).padStart(2, "0")}:${String(local_processing_time.minute).padStart(2, "0")}`;
  const enabled = args.automatic_payouts_enabled !== false;

  let schedule_status: PayoutScheduleStatus = "ACTIVE";
  if (!enabled) schedule_status = "PAUSED";
  if (frequency === "manual_only") schedule_status = "MANUAL_ONLY";

  let next_run_at_utc: string | null = null;
  let next_run_at_local: string | null = null;
  if (schedule_status === "ACTIVE" && (frequency === "weekly" || frequency === "fortnightly" || frequency === "daily")) {
    const run = computeNextWeeklyPayoutRun({
      weeklyPayoutDay: frequency === "daily" ? JS_TO_WEEKDAY[zonedParts(args.now ?? new Date(), timezone).weekday] : weekly_day,
      localProcessingTime: localTime,
      timeZone: timezone,
      now: args.now,
    });
    // Daily: next occurrence of today's-or-tomorrow processing time
    if (frequency === "daily") {
      const nowParts = zonedParts(args.now ?? new Date(), timezone);
      const nowMinutes = nowParts.hour * 60 + nowParts.minute;
      const targetMinutes = local_processing_time.hour * 60 + local_processing_time.minute;
      const add = nowMinutes >= targetMinutes ? 1 : 0;
      const d = addCalendarDays(nowParts.year, nowParts.month, nowParts.day, add);
      const utc = zonedWallTimeToUtc({
        year: d.year,
        month: d.month,
        day: d.day,
        hour: local_processing_time.hour,
        minute: local_processing_time.minute,
        timeZone: timezone,
      });
      next_run_at_utc = utc.toISOString();
      next_run_at_local = `${new Intl.DateTimeFormat("en-GB", {
        timeZone: timezone,
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).format(utc)} (${timezone})`;
    } else {
      next_run_at_utc = run.next_run_at_utc;
      next_run_at_local = run.next_run_at_local;
    }
  }

  return {
    service_area_id: args.service_area_id ?? null,
    timezone,
    automatic_payouts_enabled: enabled,
    frequency,
    weekly_day,
    local_processing_time: localTime,
    next_run_at_utc,
    next_run_at_local,
    schedule_label: buildPayoutScheduleLabel({ frequency, weeklyDay: weekly_day }),
    schedule_status,
    schedule_version: PAYOUT_SCHEDULE_VERSION,
  };
}

/** Guard: reject known legacy hardcodes in labels. */
export function assertNoLegacyMondayHardcode(label: string): boolean {
  const s = label.toLowerCase();
  return !(s.includes("weekly monday") && !s.includes("tuesday"));
}
