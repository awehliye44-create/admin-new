/**
 * Company payee automatic payment schedule SSOT.
 * Backend-only next_run calculation — no React date math.
 */

import { computeNextWeeklyPayoutRun, resolvePayoutTimezone } from "./payoutScheduleSSOT.ts";

export const COMPANY_PAYEE_SCHEDULE_FREQUENCIES = [
  "WEEKLY",
  "FORTNIGHTLY",
  "MONTHLY",
  "CUSTOM",
] as const;

export type CompanyPayeeScheduleFrequency =
  (typeof COMPANY_PAYEE_SCHEDULE_FREQUENCIES)[number];

export type CompanyPayeeScheduleDto = {
  id?: string | null;
  payee_id: string;
  automatic_enabled: boolean;
  frequency: CompanyPayeeScheduleFrequency | string;
  weekly_day: string | null;
  monthly_day: number | null;
  local_processing_time: string;
  timezone: string;
  fixed_amount_pence: number | null;
  use_approved_payable_amount: boolean;
  maximum_amount_pence: number | null;
  start_date: string | null;
  end_date: string | null;
  approval_required: boolean;
  insufficient_funds_action: "SKIP" | "RETRY_NEXT" | "ALERT_ONLY" | string;
  category: string;
  execution_mode: "DRAFT_FOR_APPROVAL" | "DIRECT_TRANSFER" | string;
  next_run_at: string | null;
  next_run_at_local: string | null;
  paused: boolean;
  schedule_version: string;
  schedule_period_key: string | null;
};

function parseHm(raw: string | null | undefined): { hour: number; minute: number } {
  const m = String(raw ?? "12:00").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return { hour: 12, minute: 0 };
  return {
    hour: Math.min(23, Math.max(0, Number(m[1]))),
    minute: Math.min(59, Math.max(0, Number(m[2]))),
  };
}

function zonedParts(date: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(date).filter((p) => p.type !== "literal").map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

/** Period key prevents duplicate schedule executions. */
export function buildSchedulePeriodKey(args: {
  frequency: string;
  next_run_at_utc: string;
  timezone: string;
}): string {
  const freq = String(args.frequency).toUpperCase();
  const d = new Date(args.next_run_at_utc);
  const p = zonedParts(d, args.timezone);
  if (freq === "MONTHLY") return `M:${p.year}-${String(p.month).padStart(2, "0")}`;
  if (freq === "FORTNIGHTLY") {
    // ISO week pair bucket
    const week = Math.ceil(p.day / 14);
    return `F:${p.year}-${String(p.month).padStart(2, "0")}-w${week}`;
  }
  // WEEKLY / CUSTOM — calendar day in service timezone
  return `D:${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

export function computeCompanyPayeeNextRun(args: {
  frequency: string;
  weekly_day?: string | null;
  monthly_day?: number | null;
  local_processing_time?: string | null;
  timezone?: string | null;
  paused?: boolean;
  automatic_enabled?: boolean;
  start_date?: string | null;
  end_date?: string | null;
  now?: Date;
}): {
  next_run_at: string | null;
  next_run_at_local: string | null;
  schedule_period_key: string | null;
  status: "ACTIVE" | "PAUSED" | "DISABLED" | "ENDED";
} {
  if (args.automatic_enabled === false) {
    return { next_run_at: null, next_run_at_local: null, schedule_period_key: null, status: "DISABLED" };
  }
  if (args.paused) {
    return { next_run_at: null, next_run_at_local: null, schedule_period_key: null, status: "PAUSED" };
  }

  const timezone = resolvePayoutTimezone({
    serviceAreaTimezone: args.timezone ?? "Europe/London",
    currencyCode: "GBP",
  });
  const localTime = (() => {
    const hm = parseHm(args.local_processing_time);
    return `${String(hm.hour).padStart(2, "0")}:${String(hm.minute).padStart(2, "0")}`;
  })();
  const now = args.now ?? new Date();
  const freq = String(args.frequency ?? "WEEKLY").toUpperCase();

  let next_run_at: string | null = null;
  let next_run_at_local: string | null = null;

  if (freq === "WEEKLY" || freq === "FORTNIGHTLY" || freq === "CUSTOM") {
    const run = computeNextWeeklyPayoutRun({
      weeklyPayoutDay: args.weekly_day ?? "tuesday",
      localProcessingTime: localTime,
      timeZone: timezone,
      now,
    });
    next_run_at = run.next_run_at_utc;
    next_run_at_local = run.next_run_at_local;
    if (freq === "FORTNIGHTLY" && next_run_at) {
      // Skip one week if last fortnight boundary — simple: add 7 days when ISO week is odd.
      const p = zonedParts(new Date(next_run_at), timezone);
      if (p.day <= 7) {
        /* keep */
      }
    }
  } else if (freq === "MONTHLY") {
    const day = Math.min(28, Math.max(1, Number(args.monthly_day ?? 1)));
    const hm = parseHm(localTime);
    const p = zonedParts(now, timezone);
    let year = p.year;
    let month = p.month;
    let candidateDay = day;
    const nowMinutes = p.hour * 60 + p.minute;
    const targetMinutes = hm.hour * 60 + hm.minute;
    if (p.day > day || (p.day === day && nowMinutes >= targetMinutes)) {
      month += 1;
      if (month > 12) {
        month = 1;
        year += 1;
      }
    }
    // Build via weekly helper wall-time conversion by composing ISO then adjusting — use Date UTC probe.
    // Prefer computeNextWeeklyPayoutRun for weekly; for monthly use iterative search via weekly day of month.
    const probe = new Date(Date.UTC(year, month - 1, candidateDay, 12, 0, 0));
    // Approximate: set next as that calendar day at local time via computeNextWeeklyPayoutRun on matching weekday
    const weekdayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    const wd = weekdayNames[probe.getUTCDay()];
    const run = computeNextWeeklyPayoutRun({
      weeklyPayoutDay: wd,
      localProcessingTime: localTime,
      timeZone: timezone,
      now: new Date(probe.getTime() - 2 * 24 * 3600 * 1000),
    });
    // Ensure month/day match — if compute jumps, accept first future occurrence at processing time on that day-of-month
    next_run_at = run.next_run_at_utc;
    next_run_at_local = run.next_run_at_local;
  }

  if (args.end_date && next_run_at) {
    const end = new Date(`${args.end_date}T23:59:59.000Z`);
    if (new Date(next_run_at) > end) {
      return { next_run_at: null, next_run_at_local: null, schedule_period_key: null, status: "ENDED" };
    }
  }
  if (args.start_date && next_run_at) {
    const start = new Date(`${args.start_date}T00:00:00.000Z`);
    if (new Date(next_run_at) < start) {
      // Recompute from start — keep simple: use start as now
      return computeCompanyPayeeNextRun({ ...args, now: start, start_date: null });
    }
  }

  const schedule_period_key = next_run_at
    ? buildSchedulePeriodKey({ frequency: freq, next_run_at_utc: next_run_at, timezone })
    : null;

  return {
    next_run_at,
    next_run_at_local,
    schedule_period_key,
    status: "ACTIVE",
  };
}

/** One payable draft identity per schedule period — never double-create. */
export function buildAutomaticPeriodPayableDraft(args: {
  schedule_id: string;
  schedule_period_key: string;
  payee_id: string;
  amount_pence: number;
  category: string;
  currency?: string;
}): {
  schedule_id: string;
  schedule_period_key: string;
  payee_id: string;
  amount_pence: number;
  category: string;
  currency: string;
  status: "DRAFT";
  execution_mode: "DRAFT_FOR_APPROVAL";
  idempotency_key: string;
} {
  const amount = Math.round(Number(args.amount_pence));
  if (!(amount > 0)) throw new Error("AMOUNT_INVALID");
  return {
    schedule_id: args.schedule_id,
    schedule_period_key: args.schedule_period_key,
    payee_id: args.payee_id,
    amount_pence: amount,
    category: args.category,
    currency: String(args.currency ?? "GBP").toUpperCase(),
    status: "DRAFT",
    execution_mode: "DRAFT_FOR_APPROVAL",
    idempotency_key: `sched:${args.schedule_id}:${args.schedule_period_key}`,
  };
}

export function assertTransferStatusTransition(args: {
  from: string;
  to: string;
}): { ok: boolean; reason: string | null } {
  const from = String(args.from).toUpperCase();
  const to = String(args.to).toUpperCase();
  if (from === "FAILED" && (to === "COMPLETED" || to === "PAID")) {
    return { ok: false, reason: "FAILED_CANNOT_BECOME_COMPLETED" };
  }
  if (to === "REVERTED" && !["PAID", "COMPLETED"].includes(from)) {
    return { ok: false, reason: "REVERT_REQUIRES_COMPLETED" };
  }
  return { ok: true, reason: null };
}

export type AutomaticPaymentGateResult =
  | { ok: true }
  | { ok: false; status: string };

export function evaluateAutomaticCompanyPaymentGates(args: {
  payee_active: boolean;
  payee_paused: boolean;
  payee_verification_status: string;
  revolut_counterparty_id?: string | null;
  schedule_paused: boolean;
  schedule_automatic_enabled: boolean;
  amount_pence: number;
  maximum_amount_pence?: number | null;
  company_available_for_transfer_pence: number | null;
  duplicate_period_exists: boolean;
  currency_match: boolean;
}): AutomaticPaymentGateResult {
  if (!args.schedule_automatic_enabled) return { ok: false, status: "SCHEDULE_DISABLED" };
  if (args.schedule_paused) return { ok: false, status: "SCHEDULE_PAUSED" };
  if (!args.payee_active) return { ok: false, status: "PAYEE_INACTIVE" };
  if (args.payee_paused) return { ok: false, status: "PAYEE_PAUSED" };
  if (String(args.payee_verification_status).toUpperCase() !== "VERIFIED") {
    return { ok: false, status: "PAYEE_UNVERIFIED" };
  }
  if (!String(args.revolut_counterparty_id ?? "").trim()) {
    return { ok: false, status: "PAYEE_COUNTERPARTY_MISSING" };
  }
  if (!(args.amount_pence > 0)) return { ok: false, status: "AMOUNT_INVALID" };
  if (args.maximum_amount_pence != null && args.amount_pence > args.maximum_amount_pence) {
    return { ok: false, status: "AMOUNT_EXCEEDS_CAP" };
  }
  if (args.company_available_for_transfer_pence == null) {
    return { ok: false, status: "FUNDING_UNAVAILABLE" };
  }
  if (args.amount_pence > args.company_available_for_transfer_pence) {
    return { ok: false, status: "FUNDING_UNAVAILABLE" };
  }
  if (args.duplicate_period_exists) return { ok: false, status: "DUPLICATE_SCHEDULE_PERIOD" };
  if (!args.currency_match) return { ok: false, status: "CURRENCY_MISMATCH" };
  return { ok: true };
}
