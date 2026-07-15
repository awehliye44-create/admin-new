/**
 * Slice 5 — Tuesday (settings-driven) weekly payout batch workflow SSOT.
 * Creates deterministic batches + items, then stops at BLOCKED_EXECUTION_DISABLED.
 * Never reserves wallets, never debit, never calls Revolut /pay.
 */

import {
  computeNextWeeklyPayoutRun,
  resolvePayoutTimezone,
  zonedWallTimeToUtc,
  type PayoutWeekday,
} from "./payoutScheduleSSOT.ts";

export const WEEKLY_PAYOUT_BATCH_KIND = "WEEKLY_SCHEDULED" as const;
/** Legacy kind — retired from active scheduler writes. */
export const LEGACY_WEEKLY_MONDAY_KIND = "WEEKLY_MONDAY" as const;

/** UI-only labels — never rewrite DB `kind`. */
export const LEGACY_MONDAY_BATCH_UI_LABEL = "Legacy Monday batch";
export const LEGACY_MONDAY_BATCH_UI_TOOLTIP =
  "Historical batch created before the Tuesday schedule SSOT migration.";

export function isLegacyMondayBatchKind(kind: string | null | undefined): boolean {
  return String(kind ?? "").toUpperCase() === LEGACY_WEEKLY_MONDAY_KIND;
}

export function isCanonicalScheduledBatchKind(kind: string | null | undefined): boolean {
  return String(kind ?? "").toUpperCase() === WEEKLY_PAYOUT_BATCH_KIND;
}

/** Display label for batch kind. Preserves raw DB value for unknown kinds. */
export function payoutBatchKindUiLabel(kind: string | null | undefined): string {
  if (isLegacyMondayBatchKind(kind)) return LEGACY_MONDAY_BATCH_UI_LABEL;
  if (kind == null || String(kind).trim() === "") return "—";
  return String(kind);
}

/**
 * Sort key for admin lists: canonical WEEKLY_SCHEDULED first, legacy Monday last.
 * Does not mutate stored rows.
 */
export function compareBatchesForAdminDisplay(
  a: { kind?: string | null; created_at?: string | null },
  b: { kind?: string | null; created_at?: string | null },
): number {
  const rank = (kind: string | null | undefined) => {
    if (isCanonicalScheduledBatchKind(kind)) return 0;
    if (isLegacyMondayBatchKind(kind)) return 2;
    return 1;
  };
  const byKind = rank(a.kind) - rank(b.kind);
  if (byKind !== 0) return byKind;
  return String(b.created_at ?? "").localeCompare(String(a.created_at ?? ""));
}

export const SLICE5_BATCH_STATUS = {
  DRAFT: "DRAFT",
  ELIGIBILITY_SNAPSHOTTED: "ELIGIBILITY_SNAPSHOTTED",
  ITEMS_CREATED: "ITEMS_CREATED",
  BLOCKED_EXECUTION_DISABLED: "BLOCKED_EXECUTION_DISABLED",
  /** Slice 6 terminal — funds held, provider submission still disabled. */
  FUNDS_RESERVED_EXECUTION_DISABLED: "FUNDS_RESERVED_EXECUTION_DISABLED",
  FAILED: "FAILED",
} as const;

export type Slice5BatchStatus =
  (typeof SLICE5_BATCH_STATUS)[keyof typeof SLICE5_BATCH_STATUS];

export const SLICE5_ITEM_STATUS = {
  CREATED: "CREATED",
  VALIDATED: "VALIDATED",
  RESERVING: "RESERVING",
  RESERVED: "RESERVED",
  BLOCKED_EXECUTION_DISABLED: "BLOCKED_EXECUTION_DISABLED",
  INELIGIBLE: "INELIGIBLE",
  FAILED: "FAILED",
} as const;

export type Slice5ItemStatus =
  (typeof SLICE5_ITEM_STATUS)[keyof typeof SLICE5_ITEM_STATUS];

export const SLICE5_ALLOWED_BATCH_STATUSES = new Set<string>(Object.values(SLICE5_BATCH_STATUS));
export const SLICE5_ALLOWED_ITEM_STATUSES = new Set<string>(Object.values(SLICE5_ITEM_STATUS));

/** Items that would conflict with creating a new pay path for the same driver. */
export const CONFLICTING_ACTIVE_ITEM_STATUSES = new Set([
  "pending",
  "processing",
  "CREATED",
  "VALIDATED",
  "RESERVING",
  "RESERVED",
  "BLOCKED_EXECUTION_DISABLED",
  "READY",
  "SCHEDULED",
  "PROCESSING",
  "TRANSFER_CREATED",
  "SUBMITTING",
  "SUBMITTED",
  "SENT",
]);

export const ADMIN_EXECUTION_DISABLED_LABEL = "Execution disabled";
export const ADMIN_FUNDS_RESERVED_LABEL = "Funds reserved — execution disabled";

export type ScheduleSettingsSnapshot = {
  payouts_enabled: boolean;
  payout_frequency: string;
  weekly_payout_day: string;
  payout_processing_time: string;
  payout_timezone: string;
};

export type ScheduleOccurrence = {
  schedule_occurrence_key: string;
  schedule_id: string;
  service_area_id: string | null;
  service_area_slug: string;
  frequency: string;
  weekly_day: string;
  timezone: string;
  scheduled_local_at: string;
  scheduled_utc_at: string;
  local_iso_with_offset: string;
  currency: string;
};

export type DriverBatchEligibilityInput = {
  driver_id: string;
  wallet_balance_pence: number;
  /** DWL available payout — never Revolut/company/session-derived. */
  available_payout_pence: number;
  payouts_enabled: boolean;
  driver_held_or_blocked: boolean;
  currency: string;
  expected_currency: string;
  destination: {
    id: string;
    is_active: boolean;
    archived_at?: string | null;
    provider_link_status?: string | null;
    provider_counterparty_id?: string | null;
    provider_recipient_account_id?: string | null;
  } | null;
  has_conflicting_active_item: boolean;
};

export type DriverBatchEligibilityResult =
  | {
    eligible: true;
    amount_pence: number;
    payout_destination_id: string;
    provider_counterparty_id: string;
    provider_recipient_account_id: string;
    wallet_snapshot_balance_pence: number;
    wallet_snapshot_available_pence: number;
    eligibility_snapshot: Record<string, unknown>;
  }
  | {
    eligible: false;
    reasons: string[];
    amount_pence: number;
    eligibility_snapshot: Record<string, unknown>;
  };

function zonedParts(date: Date, timeZone: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
} {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
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
    weekday: wd >= 0 ? wd : 1,
  };
}

function parseHm(raw: string | null | undefined): { hour: number; minute: number } {
  const m = String(raw ?? "12:00").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return { hour: 12, minute: 0 };
  return {
    hour: Math.min(23, Math.max(0, Number(m[1]))),
    minute: Math.min(59, Math.max(0, Number(m[2]))),
  };
}

/** Format +01:00 / +00:00 offset for a UTC instant in a timezone (DST-safe). */
export function formatTimezoneOffsetIso(utcInstant: Date, timeZone: string): string {
  const parts = zonedParts(utcInstant, timeZone);
  const asUtcMs = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0);
  const offsetMinutes = Math.round((asUtcMs - utcInstant.getTime()) / 60000);
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${sign}${hh}:${mm}`;
}

export function buildLocalOccurrenceIso(args: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  timeZone: string;
}): { local_iso_with_offset: string; scheduled_utc_at: string; utc: Date } {
  const utc = zonedWallTimeToUtc(args);
  const offset = formatTimezoneOffsetIso(utc, args.timeZone);
  const local = `${args.year}-${String(args.month).padStart(2, "0")}-${String(args.day).padStart(2, "0")}`
    + `T${String(args.hour).padStart(2, "0")}:${String(args.minute).padStart(2, "0")}:00${offset}`;
  return {
    local_iso_with_offset: local,
    scheduled_utc_at: utc.toISOString(),
    utc,
  };
}

export function slugifyServiceAreaName(name: string | null | undefined): string {
  const s = String(name ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "global";
}

export function buildScheduleOccurrenceKey(args: {
  serviceAreaSlug: string;
  localIsoWithOffset: string;
}): string {
  return `weekly-payout:${args.serviceAreaSlug}:${args.localIsoWithOffset}`;
}

export function buildScheduleId(settings: ScheduleSettingsSnapshot): string {
  return [
    "payout-schedule",
    String(settings.payout_frequency).toLowerCase(),
    String(settings.weekly_payout_day).toLowerCase(),
    String(settings.payout_processing_time).trim(),
    resolvePayoutTimezone({ fallback: settings.payout_timezone }),
  ].join(":");
}

/**
 * Resolve the occurrence that is due (or most recently due) for the current local clock.
 * When `force_local_iso` is provided, use that occurrence regardless of wall clock.
 */
export function resolveScheduleOccurrence(args: {
  settings: ScheduleSettingsSnapshot;
  service_area_id?: string | null;
  service_area_slug?: string | null;
  currency?: string | null;
  now?: Date;
  /** Force a specific local occurrence ISO with offset (admin/dry-run). */
  force_local_iso?: string | null;
  force_schedule_occurrence_key?: string | null;
}): ScheduleOccurrence | { not_due: true; reason: string; next_run_at_utc: string | null } {
  const settings = args.settings;
  const timeZone = resolvePayoutTimezone({
    fallback: settings.payout_timezone || "Europe/London",
  });
  const frequency = String(settings.payout_frequency ?? "weekly").toLowerCase();
  const weeklyDay = String(settings.weekly_payout_day ?? "").trim().toLowerCase();
  const { hour, minute } = parseHm(settings.payout_processing_time);
  const slug = slugifyServiceAreaName(args.service_area_slug);
  const currency = String(args.currency ?? "GBP").toUpperCase();

  if (!settings.payouts_enabled) {
    return { not_due: true, reason: "PAYOUTS_DISABLED", next_run_at_utc: null };
  }
  if (frequency === "manual_only") {
    return { not_due: true, reason: "MANUAL_ONLY_SCHEDULE", next_run_at_utc: null };
  }

  if (args.force_schedule_occurrence_key) {
    const key = String(args.force_schedule_occurrence_key).trim();
    const match = /^weekly-payout:([^:]+):(.+)$/.exec(key);
    const forcedLocal = match?.[2] ?? args.force_local_iso ?? "";
    const localMatch = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})([+-]\d{2}:\d{2}|Z)$/
      .exec(forcedLocal);
    if (!localMatch) {
      return { not_due: true, reason: "INVALID_FORCE_OCCURRENCE_KEY", next_run_at_utc: null };
    }
    const y = Number(localMatch[1]);
    const mo = Number(localMatch[2]);
    const d = Number(localMatch[3]);
    const h = Number(localMatch[4]);
    const mi = Number(localMatch[5]);
    const built = buildLocalOccurrenceIso({
      year: y, month: mo, day: d, hour: h, minute: mi, timeZone,
    });
    return {
      schedule_occurrence_key: key,
      schedule_id: buildScheduleId(settings),
      service_area_id: args.service_area_id ?? null,
      service_area_slug: match?.[1] ?? slug,
      frequency,
      weekly_day: weeklyDay,
      timezone: timeZone,
      scheduled_local_at: built.local_iso_with_offset,
      scheduled_utc_at: built.scheduled_utc_at,
      local_iso_with_offset: built.local_iso_with_offset,
      currency,
    };
  }

  if (args.force_local_iso) {
    const localMatch = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(args.force_local_iso);
    if (!localMatch) {
      return { not_due: true, reason: "INVALID_FORCE_LOCAL_ISO", next_run_at_utc: null };
    }
    const built = buildLocalOccurrenceIso({
      year: Number(localMatch[1]),
      month: Number(localMatch[2]),
      day: Number(localMatch[3]),
      hour: Number(localMatch[4]),
      minute: Number(localMatch[5]),
      timeZone,
    });
    const key = buildScheduleOccurrenceKey({
      serviceAreaSlug: slug,
      localIsoWithOffset: built.local_iso_with_offset,
    });
    return {
      schedule_occurrence_key: key,
      schedule_id: buildScheduleId(settings),
      service_area_id: args.service_area_id ?? null,
      service_area_slug: slug,
      frequency,
      weekly_day: weeklyDay,
      timezone: timeZone,
      scheduled_local_at: built.local_iso_with_offset,
      scheduled_utc_at: built.scheduled_utc_at,
      local_iso_with_offset: built.local_iso_with_offset,
      currency,
    };
  }

  const now = args.now ?? new Date();
  const next = computeNextWeeklyPayoutRun({
    weeklyPayoutDay: weeklyDay as PayoutWeekday,
    localProcessingTime: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
    timeZone,
    now,
  });

  // Due = today's configured day+time has passed (or is exactly now).
  const nowParts = zonedParts(now, timeZone);
  const WEEKDAY_TO_JS: Record<string, number> = {
    sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
    thursday: 4, friday: 5, saturday: 6,
  };
  const targetDow = WEEKDAY_TO_JS[weeklyDay];
  if (targetDow == null) {
    return { not_due: true, reason: "MISCONFIGURED_DAY", next_run_at_utc: next.next_run_at_utc };
  }

  const nowMinutes = nowParts.hour * 60 + nowParts.minute;
  const targetMinutes = hour * 60 + minute;
  const isDueToday =
    nowParts.weekday === targetDow && nowMinutes >= targetMinutes;

  if (!isDueToday) {
    return {
      not_due: true,
      reason: nowParts.weekday !== targetDow ? "WRONG_PAYOUT_DAY" : "WRONG_PAYOUT_TIME",
      next_run_at_utc: next.next_run_at_utc,
    };
  }

  const built = buildLocalOccurrenceIso({
    year: nowParts.year,
    month: nowParts.month,
    day: nowParts.day,
    hour,
    minute,
    timeZone,
  });
  const key = buildScheduleOccurrenceKey({
    serviceAreaSlug: slug,
    localIsoWithOffset: built.local_iso_with_offset,
  });

  return {
    schedule_occurrence_key: key,
    schedule_id: buildScheduleId(settings),
    service_area_id: args.service_area_id ?? null,
    service_area_slug: slug,
    frequency,
    weekly_day: weeklyDay,
    timezone: timeZone,
    scheduled_local_at: built.local_iso_with_offset,
    scheduled_utc_at: built.scheduled_utc_at,
    local_iso_with_offset: built.local_iso_with_offset,
    currency,
  };
}

/**
 * Admin/ops force: most recently due occurrence for the configured weekday+time
 * (today if already past processing time on payout day; otherwise previous week).
 */
export function resolveMostRecentDueOccurrence(args: {
  settings: ScheduleSettingsSnapshot;
  service_area_id?: string | null;
  service_area_slug?: string | null;
  currency?: string | null;
  now?: Date;
}): ScheduleOccurrence | { not_due: true; reason: string; next_run_at_utc: string | null } {
  const settings = args.settings;
  if (!settings.payouts_enabled) {
    return { not_due: true, reason: "PAYOUTS_DISABLED", next_run_at_utc: null };
  }
  const timeZone = resolvePayoutTimezone({
    fallback: settings.payout_timezone || "Europe/London",
  });
  const weeklyDay = String(settings.weekly_payout_day ?? "").trim().toLowerCase();
  const { hour, minute } = parseHm(settings.payout_processing_time);
  const WEEKDAY_TO_JS: Record<string, number> = {
    sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
    thursday: 4, friday: 5, saturday: 6,
  };
  const targetDow = WEEKDAY_TO_JS[weeklyDay];
  if (targetDow == null) {
    return { not_due: true, reason: "MISCONFIGURED_DAY", next_run_at_utc: null };
  }

  const now = args.now ?? new Date();
  const nowParts = zonedParts(now, timeZone);
  let daysBack = (nowParts.weekday - targetDow + 7) % 7;
  const nowMinutes = nowParts.hour * 60 + nowParts.minute;
  const targetMinutes = hour * 60 + minute;
  if (daysBack === 0 && nowMinutes < targetMinutes) daysBack = 7;
  if (daysBack === 0 && nowMinutes >= targetMinutes) daysBack = 0;

  const utcCursor = new Date(Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day - daysBack));
  const y = utcCursor.getUTCFullYear();
  const mo = utcCursor.getUTCMonth() + 1;
  const d = utcCursor.getUTCDate();
  const built = buildLocalOccurrenceIso({
    year: y, month: mo, day: d, hour, minute, timeZone,
  });
  const slug = slugifyServiceAreaName(args.service_area_slug);
  const key = buildScheduleOccurrenceKey({
    serviceAreaSlug: slug,
    localIsoWithOffset: built.local_iso_with_offset,
  });
  return {
    schedule_occurrence_key: key,
    schedule_id: buildScheduleId(settings),
    service_area_id: args.service_area_id ?? null,
    service_area_slug: slug,
    frequency: String(settings.payout_frequency ?? "weekly").toLowerCase(),
    weekly_day: weeklyDay,
    timezone: timeZone,
    scheduled_local_at: built.local_iso_with_offset,
    scheduled_utc_at: built.scheduled_utc_at,
    local_iso_with_offset: built.local_iso_with_offset,
    currency: String(args.currency ?? "GBP").toUpperCase(),
  };
}

export function evaluateDriverBatchEligibility(
  input: DriverBatchEligibilityInput,
): DriverBatchEligibilityResult {
  const reasons: string[] = [];
  const available = Math.max(0, Math.round(Number(input.available_payout_pence ?? 0)));
  const balance = Math.round(Number(input.wallet_balance_pence ?? 0));
  const currency = String(input.currency ?? "").toUpperCase();
  const expected = String(input.expected_currency ?? "GBP").toUpperCase();

  if (!input.payouts_enabled) reasons.push("DRIVER_PAYOUTS_DISABLED");
  if (input.driver_held_or_blocked) reasons.push("DRIVER_HELD_OR_BLOCKED");
  if (available <= 0) reasons.push("AVAILABLE_PAYOUT_ZERO");
  if (currency !== expected) reasons.push("CURRENCY_MISMATCH");
  if (input.has_conflicting_active_item) reasons.push("CONFLICTING_ACTIVE_PAYOUT_ITEM");

  const dest = input.destination;
  if (!dest) {
    reasons.push("NO_ACTIVE_DESTINATION");
  } else {
    if (!dest.is_active || dest.archived_at) reasons.push("DESTINATION_INACTIVE");
    const link = String(dest.provider_link_status ?? "").toUpperCase();
    if (link !== "PROVIDER_VERIFIED") reasons.push("PROVIDER_LINKAGE_REQUIRED");
    if (!dest.provider_counterparty_id) reasons.push("MISSING_COUNTERPARTY");
    if (!dest.provider_recipient_account_id) reasons.push("MISSING_RECIPIENT_ACCOUNT");
  }

  const snapshot: Record<string, unknown> = {
    source: "driver_wallet_ledger_ssot",
    driver_id: input.driver_id,
    wallet_balance_pence: balance,
    available_payout_pence: available,
    currency,
    expected_currency: expected,
    payouts_enabled: input.payouts_enabled,
    driver_held_or_blocked: input.driver_held_or_blocked,
    has_conflicting_active_item: input.has_conflicting_active_item,
    destination_id: dest?.id ?? null,
    provider_link_status: dest?.provider_link_status ?? null,
    reasons,
    excluded_sources: [
      "revolut_account_balance",
      "payment_sessions",
      "trip_rows_direct",
      "customer_capture_amount",
      "company_balance",
    ],
  };

  if (reasons.length > 0 || !dest) {
    return { eligible: false, reasons, amount_pence: 0, eligibility_snapshot: snapshot };
  }

  return {
    eligible: true,
    amount_pence: available,
    payout_destination_id: dest.id,
    provider_counterparty_id: String(dest.provider_counterparty_id),
    provider_recipient_account_id: String(dest.provider_recipient_account_id),
    wallet_snapshot_balance_pence: balance,
    wallet_snapshot_available_pence: available,
    eligibility_snapshot: snapshot,
  };
}

export function itemProviderRequestId(batchId: string, driverId: string): string {
  return `weekly-payout-item:${batchId}:${driverId}`;
}

export function itemIdempotencyKey(occurrenceKey: string, driverId: string): string {
  return `${occurrenceKey}:${driverId}`;
}

function getDenoEnv(): { get(key: string): string | undefined } {
  const g = globalThis as { Deno?: { env: { get(k: string): string | undefined } } };
  return g.Deno?.env ?? { get: () => undefined };
}

export function isLivePayoutExecutionEnabled(
  env: { get(key: string): string | undefined } = getDenoEnv(),
): boolean {
  return (env.get("LIVE_PAYOUT_EXECUTION_ENABLED") ?? "false").trim().toLowerCase() === "true";
}

export function isRevolutPaymentTransportEnabled(
  env: { get(key: string): string | undefined } = getDenoEnv(),
): boolean {
  return (env.get("REVOLUT_PAYMENT_TRANSPORT_ENABLED") ?? "false").trim().toLowerCase() === "true";
}


/** Slice 5 stops here when either gate is off. */
export function shouldBlockExecutionDisabled(env?: {
  get(key: string): string | undefined;
}): boolean {
  return !isLivePayoutExecutionEnabled(env) || !isRevolutPaymentTransportEnabled(env);
}

export function assertSlice5MoneySafety(args: {
  wallet_reserved?: boolean;
  wallet_debited?: boolean;
  revolut_pay_called?: boolean;
  relay_payment_called?: boolean;
  slices_6_to_12_started?: boolean;
}): void {
  if (args.wallet_reserved) throw new Error("SLICE5_INVARIANT: wallet reserved");
  if (args.wallet_debited) throw new Error("SLICE5_INVARIANT: wallet debited");
  if (args.revolut_pay_called) throw new Error("SLICE5_INVARIANT: Revolut /pay called");
  if (args.relay_payment_called) throw new Error("SLICE5_INVARIANT: relay payment called");
  if (args.slices_6_to_12_started) throw new Error("SLICE5_INVARIANT: slices 6–12 started");
}

/** Reject active Monday hardcodes in scheduler labels / kinds. */
export function assertNoActiveMondayHardcode(text: string): boolean {
  const s = text.toLowerCase();
  if (s.includes("weekly_monday") || s.includes("weekly-monday")) return false;
  if (s === "monday" || s.includes("hardcoded monday")) return false;
  return true;
}

export function adminBatchStatusLabel(status: string): string {
  if (status === SLICE5_BATCH_STATUS.FUNDS_RESERVED_EXECUTION_DISABLED) {
    return ADMIN_FUNDS_RESERVED_LABEL;
  }
  if (status === SLICE5_BATCH_STATUS.BLOCKED_EXECUTION_DISABLED) {
    return ADMIN_EXECUTION_DISABLED_LABEL;
  }
  return status;
}

export function sumEligibleAmounts(
  items: Array<{ amount_pence: number }>,
): number {
  return items.reduce((s, i) => s + Math.max(0, Math.round(Number(i.amount_pence ?? 0))), 0);
}
