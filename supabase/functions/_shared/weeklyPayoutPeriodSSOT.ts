/**
 * Weekly payout earning-period SSOT.
 *
 * A weekly occurrence pays only the previous completed Europe/London calendar
 * week. Identity is (schedule_occurrence_key, dry_run). Period boundaries are
 * derived from the occurrence key / scheduled local time — never from delayed
 * execution now(), clearing time, or cumulative available_balance_pence.
 *
 * Classifications closed by this module + 20261124160000:
 * - WEEKLY_PERIOD_SCOPE_BUG — eligibility used cumulative available balance
 * - DELAYED_EXECUTION_AMOUNT_DRIFT — newly cleared current-week credits entered
 * Claim identity remains CLAIM_CONSTRAINT_BUG (20261124150000).
 */

import { zonedWallTimeToUtc } from "./payoutScheduleSSOT.ts";
import {
  earningsAttributionInstant,
  isInstantInHalfOpenRange,
} from "./economicEarnedAtSSOT.ts";

export const WEEKLY_PAYOUT_PERIOD_TIMEZONE = "Europe/London";

export const WEEKLY_PERIOD_CLASSIFICATION = {
  CLAIM_CONSTRAINT_BUG: "CLAIM_CONSTRAINT_BUG",
  WEEKLY_PERIOD_SCOPE_BUG: "WEEKLY_PERIOD_SCOPE_BUG",
  DELAYED_EXECUTION_AMOUNT_DRIFT: "DELAYED_EXECUTION_AMOUNT_DRIFT",
} as const;

export const WEEKLY_CREDIT_BUCKET = {
  PREVIOUS_WEEK_PAYABLE: "PREVIOUS_WEEK_PAYABLE",
  CURRENT_WEEK_EXCLUDED: "CURRENT_WEEK_EXCLUDED",
  OLDER_UNPAID: "OLDER_UNPAID",
  ALREADY_PAID: "ALREADY_PAID",
  UNATTRIBUTED: "UNATTRIBUTED",
} as const;

export type WeeklyCreditBucket =
  (typeof WEEKLY_CREDIT_BUCKET)[keyof typeof WEEKLY_CREDIT_BUCKET];

export type WeeklyOccurrencePeriod = {
  period_start: string;
  period_end: string;
  timezone: string;
};

export type WeeklyPeriodCredit = {
  ledger_entry_id: string;
  trip_id?: string | null;
  amount_pence: number;
  type?: string | null;
  economic_earned_at?: string | null;
  posting_created_at?: string | null;
  created_at?: string | null;
  unpaid_pence?: number;
};

function londonDateParts(instant: Date, timeZone: string): {
  year: number;
  month: number;
  day: number;
  weekday: number;
} {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(instant).filter((p) => p.type !== "literal").map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday ?? "Mon");
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    weekday: wd >= 0 ? wd : 1,
  };
}

function addCalendarDays(year: number, month: number, day: number, add: number): {
  year: number;
  month: number;
  day: number;
} {
  const utc = new Date(Date.UTC(year, month - 1, day + add));
  return { year: utc.getUTCFullYear(), month: utc.getUTCMonth() + 1, day: utc.getUTCDate() };
}

export function parseWeeklyOccurrenceScheduledLocal(key: string | null | undefined): string | null {
  const match = /^weekly-payout:[^:]+:(.+)$/.exec(String(key ?? "").trim());
  return match?.[1] ?? null;
}

/**
 * Previous completed calendar week relative to the occurrence's local date:
 * Monday 00:00 of the week containing the occurrence is period_end (exclusive);
 * the Monday 7 days earlier is period_start (inclusive).
 *
 * Tuesday 2026-09-22 12:00 Europe/London →
 *   [2026-09-14 00:00 Europe/London, 2026-09-21 00:00 Europe/London).
 */
export function resolvePreviousCompletedCalendarWeek(args: {
  scheduled_local_at?: string | null;
  schedule_occurrence_key?: string | null;
  timezone?: string | null;
  /** Ignored. Period is never derived from delayed execution time. */
  now?: Date | string | null;
}): WeeklyOccurrencePeriod {
  void args.now;
  const timeZone = String(args.timezone ?? "").trim() || WEEKLY_PAYOUT_PERIOD_TIMEZONE;
  const local = String(args.scheduled_local_at ?? "").trim()
    || parseWeeklyOccurrenceScheduledLocal(args.schedule_occurrence_key)
    || "";
  const instant = new Date(local);
  if (!Number.isFinite(instant.getTime())) {
    throw new Error("WEEKLY_PERIOD_INVALID_SCHEDULED_LOCAL");
  }
  const parts = londonDateParts(instant, timeZone);
  const daysBackToMonday = (parts.weekday + 6) % 7;
  const thisMonday = addCalendarDays(parts.year, parts.month, parts.day, -daysBackToMonday);
  const prevMonday = addCalendarDays(thisMonday.year, thisMonday.month, thisMonday.day, -7);
  const period_end = zonedWallTimeToUtc({
    year: thisMonday.year,
    month: thisMonday.month,
    day: thisMonday.day,
    hour: 0,
    minute: 0,
    timeZone,
  }).toISOString();
  const period_start = zonedWallTimeToUtc({
    year: prevMonday.year,
    month: prevMonday.month,
    day: prevMonday.day,
    hour: 0,
    minute: 0,
    timeZone,
  }).toISOString();
  return { period_start, period_end, timezone: timeZone };
}

export function freezeWeeklyOccurrencePeriod(args: {
  frozen_period_start?: string | null;
  frozen_period_end?: string | null;
  scheduled_local_at?: string | null;
  schedule_occurrence_key?: string | null;
  timezone?: string | null;
  now?: Date | string | null;
}): WeeklyOccurrencePeriod {
  const computed = resolvePreviousCompletedCalendarWeek(args);
  const startRaw = String(args.frozen_period_start ?? "").trim();
  const endRaw = String(args.frozen_period_end ?? "").trim();
  if (startRaw && endRaw) {
    const start = new Date(startRaw);
    const end = new Date(endRaw);
    if (Number.isFinite(start.getTime()) && Number.isFinite(end.getTime()) && end.getTime() > start.getTime()) {
      return {
        period_start: start.toISOString(),
        period_end: end.toISOString(),
        timezone: computed.timezone,
      };
    }
  }
  return computed;
}

export function classifyWeeklyPeriodCredit(args: {
  entry: WeeklyPeriodCredit;
  period_start: string;
  period_end: string;
}): WeeklyCreditBucket {
  const unpaid = Math.max(
    0,
    Math.round(Number(args.entry.unpaid_pence ?? args.entry.amount_pence ?? 0)),
  );
  if (unpaid <= 0) return WEEKLY_CREDIT_BUCKET.ALREADY_PAID;
  const attributed = earningsAttributionInstant({
    type: args.entry.type,
    created_at: args.entry.created_at,
    posting_created_at: args.entry.posting_created_at,
    economic_earned_at: args.entry.economic_earned_at,
  });
  if (!attributed) return WEEKLY_CREDIT_BUCKET.UNATTRIBUTED;
  if (isInstantInHalfOpenRange(attributed, args.period_start, args.period_end)) {
    return WEEKLY_CREDIT_BUCKET.PREVIOUS_WEEK_PAYABLE;
  }
  const t = Date.parse(attributed);
  const end = Date.parse(args.period_end);
  if (Number.isFinite(t) && Number.isFinite(end) && t >= end) {
    return WEEKLY_CREDIT_BUCKET.CURRENT_WEEK_EXCLUDED;
  }
  return WEEKLY_CREDIT_BUCKET.OLDER_UNPAID;
}

export function selectWeeklyPeriodPayableCredits(args: {
  entries: ReadonlyArray<WeeklyPeriodCredit>;
  period_start: string;
  period_end: string;
}): {
  amount_pence: number;
  selected: WeeklyPeriodCredit[];
  excluded_current_week_pence: number;
  excluded_older_unpaid_pence: number;
  already_paid_pence: number;
  unattributed_pence: number;
} {
  const selected: WeeklyPeriodCredit[] = [];
  let amount_pence = 0;
  let excluded_current_week_pence = 0;
  let excluded_older_unpaid_pence = 0;
  let already_paid_pence = 0;
  let unattributed_pence = 0;
  for (const entry of args.entries) {
    const bucket = classifyWeeklyPeriodCredit({
      entry,
      period_start: args.period_start,
      period_end: args.period_end,
    });
    const unpaid = Math.max(0, Math.round(Number(entry.unpaid_pence ?? entry.amount_pence ?? 0)));
    if (bucket === WEEKLY_CREDIT_BUCKET.PREVIOUS_WEEK_PAYABLE) {
      selected.push(entry);
      amount_pence += unpaid;
      continue;
    }
    if (bucket === WEEKLY_CREDIT_BUCKET.CURRENT_WEEK_EXCLUDED) {
      excluded_current_week_pence += unpaid;
    } else if (bucket === WEEKLY_CREDIT_BUCKET.OLDER_UNPAID) {
      excluded_older_unpaid_pence += unpaid;
    } else if (bucket === WEEKLY_CREDIT_BUCKET.ALREADY_PAID) {
      already_paid_pence += Math.max(0, Math.round(Number(entry.amount_pence ?? 0)));
    } else {
      unattributed_pence += unpaid;
    }
  }
  return {
    amount_pence,
    selected,
    excluded_current_week_pence,
    excluded_older_unpaid_pence,
    already_paid_pence,
    unattributed_pence,
  };
}

export function resolveWeeklyOccurrenceMoneyAmounts(args: {
  frozen_items: ReadonlyArray<{ driver_id: string; amount_pence: number }>;
  planned_items: ReadonlyArray<{ driver_id: string; amount_pence: number }>;
}): {
  source: "FROZEN_OCCURRENCE_MANIFEST" | "PERIOD_SCOPED_ELIGIBILITY";
  required_batch_pence: number;
  items: Array<{ driver_id: string; amount_pence: number }>;
} {
  if (args.frozen_items.length > 0) {
    const items = args.frozen_items.map((it) => ({
      driver_id: String(it.driver_id),
      amount_pence: Math.max(0, Math.round(Number(it.amount_pence ?? 0))),
    }));
    return {
      source: "FROZEN_OCCURRENCE_MANIFEST",
      required_batch_pence: items.reduce((s, it) => s + it.amount_pence, 0),
      items,
    };
  }
  const items = args.planned_items.map((it) => ({
    driver_id: String(it.driver_id),
    amount_pence: Math.max(0, Math.round(Number(it.amount_pence ?? 0))),
  }));
  return {
    source: "PERIOD_SCOPED_ELIGIBILITY",
    required_batch_pence: items.reduce((s, it) => s + it.amount_pence, 0),
    items,
  };
}

export const WEEKLY_PAYOUT_FEE_PENCE = 0;
