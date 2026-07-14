/**
 * Payout Ledger control-centre settings SSOT — pure policy application.
 * Reads admin_settings keys persisted by PayoutLedgerSettingsPanel.
 * Does not recalculate earnings; only gates/caps Available Payout amounts.
 */

export type PayoutRuleMode = "allow" | "hold" | "block";

export type PayoutControlCentreSettings = {
  payouts_enabled: boolean;
  payout_frequency: "daily" | "weekly" | "fortnightly" | "monthly" | "manual_only";
  weekly_payout_day: string;
  payout_processing_time: string;
  /** IANA timezone for day/time gates (service-area timezone when scoped). */
  payout_timezone: string;
  payout_min_pence: number;
  payout_max_pence: number | null;
  payout_rule_negative_wallet: PayoutRuleMode;
  payout_rule_pending_disputes: PayoutRuleMode;
  payout_rule_pending_chargebacks: PayoutRuleMode;
  payout_rule_manual_review: PayoutRuleMode;
  payout_rule_suspended_driver: PayoutRuleMode;
  payout_rule_expired_documents: PayoutRuleMode;
  early_cashout_fee_pence: number;
  early_cashout_min_pence: number;
  early_cashout_max_pence: number | null;
  early_cashout_max_per_day: number;
};

export type PayoutControlCentreDriverFlags = {
  wallet_balance_pence: number;
  has_pending_disputes?: boolean;
  has_pending_chargebacks?: boolean;
  manual_review_required?: boolean;
  is_suspended?: boolean;
  has_expired_documents?: boolean;
};

export type PayoutControlCentreDecision = {
  allowed: boolean;
  hold: boolean;
  amount_pence: number;
  reasons: string[];
};

const DEFAULTS: PayoutControlCentreSettings = {
  payouts_enabled: true,
  payout_frequency: "weekly",
  weekly_payout_day: "tuesday",
  payout_processing_time: "12:00",
  payout_timezone: "Europe/London",
  payout_min_pence: 0,
  payout_max_pence: null,
  payout_rule_negative_wallet: "block",
  payout_rule_pending_disputes: "block",
  payout_rule_pending_chargebacks: "block",
  payout_rule_manual_review: "hold",
  payout_rule_suspended_driver: "block",
  payout_rule_expired_documents: "block",
  early_cashout_fee_pence: 100,
  early_cashout_min_pence: 500,
  early_cashout_max_pence: null,
  early_cashout_max_per_day: 1,
};

function parseMode(raw: unknown, fallback: PayoutRuleMode): PayoutRuleMode {
  const v = String(raw ?? "").replace(/^"|"$/g, "").toLowerCase();
  if (v === "allow" || v === "hold" || v === "block") return v;
  return fallback;
}

function parseBool(raw: unknown, fallback: boolean): boolean {
  if (typeof raw === "boolean") return raw;
  const v = String(raw ?? "").replace(/^"|"$/g, "").toLowerCase();
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  return fallback;
}

function parseIntOr(raw: unknown, fallback: number): number {
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.round(raw);
  const n = Number(String(raw ?? "").replace(/^"|"$/g, ""));
  return Number.isFinite(n) ? Math.round(n) : fallback;
}

function parseNullableInt(raw: unknown): number | null {
  if (raw == null || raw === "") return null;
  const n = parseIntOr(raw, NaN);
  return Number.isFinite(n) ? n : null;
}

/** Map admin_settings key→value rows into typed control-centre settings. */
export function parsePayoutControlCentreSettings(
  map: Record<string, unknown>,
): PayoutControlCentreSettings {
  const freqRaw = String(map.payout_frequency ?? DEFAULTS.payout_frequency)
    .replace(/^"|"$/g, "")
    .toLowerCase();
  const frequency = (
    ["daily", "weekly", "fortnightly", "monthly", "manual_only"] as const
  ).includes(freqRaw as PayoutControlCentreSettings["payout_frequency"])
    ? (freqRaw as PayoutControlCentreSettings["payout_frequency"])
    : DEFAULTS.payout_frequency;

  return {
    payouts_enabled: parseBool(map.payouts_enabled, DEFAULTS.payouts_enabled),
    payout_frequency: frequency,
    weekly_payout_day: String(map.weekly_payout_day ?? DEFAULTS.weekly_payout_day)
      .replace(/^"|"$/g, "")
      .toLowerCase() || DEFAULTS.weekly_payout_day,
    payout_processing_time: String(map.payout_processing_time ?? DEFAULTS.payout_processing_time)
      .replace(/^"|"$/g, "") || DEFAULTS.payout_processing_time,
    payout_timezone: String(map.payout_timezone ?? DEFAULTS.payout_timezone)
      .replace(/^"|"$/g, "")
      .trim() || DEFAULTS.payout_timezone,
    payout_min_pence: Math.max(0, parseIntOr(map.payout_min_pence, DEFAULTS.payout_min_pence)),
    payout_max_pence: parseNullableInt(map.payout_max_pence),
    payout_rule_negative_wallet: parseMode(map.payout_rule_negative_wallet, DEFAULTS.payout_rule_negative_wallet),
    payout_rule_pending_disputes: parseMode(map.payout_rule_pending_disputes, DEFAULTS.payout_rule_pending_disputes),
    payout_rule_pending_chargebacks: parseMode(map.payout_rule_pending_chargebacks, DEFAULTS.payout_rule_pending_chargebacks),
    payout_rule_manual_review: parseMode(map.payout_rule_manual_review, DEFAULTS.payout_rule_manual_review),
    payout_rule_suspended_driver: parseMode(map.payout_rule_suspended_driver, DEFAULTS.payout_rule_suspended_driver),
    payout_rule_expired_documents: parseMode(map.payout_rule_expired_documents, DEFAULTS.payout_rule_expired_documents),
    early_cashout_fee_pence: Math.max(0, parseIntOr(map.early_cashout_fee_pence, DEFAULTS.early_cashout_fee_pence)),
    early_cashout_min_pence: Math.max(0, parseIntOr(map.early_cashout_min_pence, DEFAULTS.early_cashout_min_pence)),
    early_cashout_max_pence: parseNullableInt(map.early_cashout_max_pence),
    early_cashout_max_per_day: Math.max(1, parseIntOr(map.early_cashout_max_per_day, DEFAULTS.early_cashout_max_per_day)),
  };
}

function applyRule(
  mode: PayoutRuleMode,
  triggered: boolean,
  code: string,
  reasons: string[],
): { block: boolean; hold: boolean } {
  if (!triggered || mode === "allow") return { block: false, hold: false };
  if (mode === "block") {
    reasons.push(code);
    return { block: true, hold: false };
  }
  reasons.push(`${code}_HOLD`);
  return { block: false, hold: true };
}

/**
 * Apply control-centre policy to an already-computed Available Payout amount.
 * Never recalculates earnings — only gates and caps.
 */
export function applyPayoutControlCentrePolicy(
  availablePayoutPence: number,
  settings: PayoutControlCentreSettings,
  flags: PayoutControlCentreDriverFlags,
): PayoutControlCentreDecision {
  const reasons: string[] = [];
  let hold = false;

  if (!settings.payouts_enabled) {
    return { allowed: false, hold: false, amount_pence: 0, reasons: ["PAYOUTS_DISABLED"] };
  }
  if (settings.payout_frequency === "manual_only") {
    return { allowed: false, hold: false, amount_pence: 0, reasons: ["MANUAL_ONLY_SCHEDULE"] };
  }

  const neg = applyRule(
    settings.payout_rule_negative_wallet,
    flags.wallet_balance_pence < 0,
    "NEGATIVE_WALLET",
    reasons,
  );
  const disputes = applyRule(
    settings.payout_rule_pending_disputes,
    Boolean(flags.has_pending_disputes),
    "PENDING_DISPUTES",
    reasons,
  );
  const chargebacks = applyRule(
    settings.payout_rule_pending_chargebacks,
    Boolean(flags.has_pending_chargebacks),
    "PENDING_CHARGEBACKS",
    reasons,
  );
  const review = applyRule(
    settings.payout_rule_manual_review,
    Boolean(flags.manual_review_required),
    "MANUAL_REVIEW",
    reasons,
  );
  const suspended = applyRule(
    settings.payout_rule_suspended_driver,
    Boolean(flags.is_suspended),
    "SUSPENDED_DRIVER",
    reasons,
  );
  const expired = applyRule(
    settings.payout_rule_expired_documents,
    Boolean(flags.has_expired_documents),
    "EXPIRED_DOCUMENTS",
    reasons,
  );

  if (neg.block || disputes.block || chargebacks.block || review.block || suspended.block || expired.block) {
    return { allowed: false, hold: false, amount_pence: 0, reasons };
  }
  hold = neg.hold || disputes.hold || chargebacks.hold || review.hold || suspended.hold || expired.hold;

  let amount = Math.max(0, Math.round(availablePayoutPence));
  if (settings.payout_max_pence != null) {
    amount = Math.min(amount, settings.payout_max_pence);
  }
  if (amount < settings.payout_min_pence) {
    return {
      allowed: false,
      hold,
      amount_pence: 0,
      reasons: [...reasons, "BELOW_MIN_PAYOUT"],
    };
  }
  if (hold) {
    return { allowed: false, hold: true, amount_pence: amount, reasons };
  }
  return { allowed: true, hold: false, amount_pence: amount, reasons };
}

/** Validate an instant cash-out request against control-centre limits (no earnings math). */
export function applyInstantCashoutPolicy(
  requestedPence: number,
  settings: PayoutControlCentreSettings,
  requestsToday: number,
): { allowed: boolean; reasons: string[]; fee_pence: number } {
  const reasons: string[] = [];
  const amount = Math.max(0, Math.round(requestedPence));
  if (amount < settings.early_cashout_min_pence) reasons.push("BELOW_MIN_CASHOUT");
  if (settings.early_cashout_max_pence != null && amount > settings.early_cashout_max_pence) {
    reasons.push("ABOVE_MAX_CASHOUT");
  }
  if (requestsToday >= settings.early_cashout_max_per_day) reasons.push("MAX_CASHOUTS_PER_DAY");
  return {
    allowed: reasons.length === 0,
    reasons,
    fee_pence: settings.early_cashout_fee_pence,
  };
}

export async function loadPayoutControlCentreSettings(
  // deno-lint-ignore no-explicit-any
  supabase: { from: (t: string) => any },
  args?: { serviceAreaId?: string | null },
): Promise<PayoutControlCentreSettings> {
  const keys = [
    "payouts_enabled",
    "payout_frequency",
    "weekly_payout_day",
    "payout_processing_time",
    "payout_min_pence",
    "payout_max_pence",
    "payout_rule_negative_wallet",
    "payout_rule_pending_disputes",
    "payout_rule_pending_chargebacks",
    "payout_rule_manual_review",
    "payout_rule_suspended_driver",
    "payout_rule_expired_documents",
    "early_cashout_fee_pence",
    "early_cashout_min_pence",
    "early_cashout_max_pence",
    "early_cashout_max_per_day",
  ];
  const saKey = args?.serviceAreaId ? `payout_sa_override:${args.serviceAreaId}` : null;
  const { data, error } = await supabase
    .from("admin_settings")
    .select("setting_key, setting_value")
    .in("setting_key", saKey ? [...keys, saKey] : keys);
  if (error) throw error;
  const map: Record<string, unknown> = {};
  for (const row of data ?? []) {
    map[row.setting_key] = row.setting_value;
  }
  const base = parsePayoutControlCentreSettings(map);
  if (args?.serviceAreaId) {
    const { data: area } = await supabase
      .from("service_areas")
      .select("timezone")
      .eq("id", args.serviceAreaId)
      .maybeSingle();
    const tz = String(area?.timezone ?? "").trim();
    if (tz) base.payout_timezone = tz;
  }
  if (!saKey || map[saKey] == null) return base;
  let override: Record<string, unknown> = {};
  try {
    const raw = map[saKey];
    override = typeof raw === "string"
      ? JSON.parse(raw.replace(/^"|"$/g, ""))
      : (raw as Record<string, unknown>);
  } catch {
    return base;
  }
  const merged = parsePayoutControlCentreSettings({ ...map, ...override });
  if (!override.payout_timezone) merged.payout_timezone = base.payout_timezone;
  return merged;
}
