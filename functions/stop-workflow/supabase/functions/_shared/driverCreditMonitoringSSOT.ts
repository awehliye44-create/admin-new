/**
 * Driver-earning credit monitoring SSOT (read-only, PLATFORM_COLLECTED only).
 * Consumes trip settlement stamps, Payment Sessions evidence, and Driver Wallet Ledger —
 * never writes wallet entries, never repairs money, never includes Commission Wallet.
 */

import {
  DEFAULT_PAYOUT_CLEARING_DELAY_HOURS,
  PAYOUT_ELIGIBLE_LEDGER_TYPES,
} from "./driverPayoutEligibilitySSOT.ts";
import { evaluateFrSettlementCaptureIdentity } from "./frConsumeOnlySSOT.ts";

export { DEFAULT_PAYOUT_CLEARING_DELAY_HOURS } from "./driverPayoutEligibilitySSOT.ts";

export const DRIVER_CREDIT_HEALTH = {
  OK: "OK",
  MISSING: "MISSING",
  UNDER_CREDITED: "UNDER_CREDITED",
  OVER_CREDITED: "OVER_CREDITED",
  DUPLICATE: "DUPLICATE",
  WRONG_DRIVER: "WRONG_DRIVER",
  PENDING: "PENDING",
  NOT_APPLICABLE: "NOT_APPLICABLE",
} as const;

export type DriverCreditHealth =
  typeof DRIVER_CREDIT_HEALTH[keyof typeof DRIVER_CREDIT_HEALTH];

export const PAYMENT_SESSION_DRIVER_CREDIT_DISPLAY = {
  PENDING: "Pending",
  CREDITED: "Credited",
  EXCEPTION: "Exception",
  NOT_APPLICABLE: "Not applicable",
} as const;

export type PaymentSessionDriverCreditDisplay =
  typeof PAYMENT_SESSION_DRIVER_CREDIT_DISPLAY[keyof typeof PAYMENT_SESSION_DRIVER_CREDIT_DISPLAY];

export const PAYOUT_CREDIT_INTEGRITY = {
  WALLET_CREDIT_VERIFIED: "Wallet credit verified",
  CREDIT_PENDING: "Credit pending",
  CREDIT_EXCEPTION: "Credit exception",
  PAYOUT_RESERVED: "Payout reserved",
  PAID: "Paid",
} as const;

export type PayoutCreditIntegrityStatus =
  typeof PAYOUT_CREDIT_INTEGRITY[keyof typeof PAYOUT_CREDIT_INTEGRITY];

/** Grace after provider capture before a completed trip flags missing wallet credit. */
export const DRIVER_CREDIT_PROCESSING_GRACE_MS = 5 * 60 * 1000;

const TOLERANCE_PENCE = 1;

const PROVIDER_PENDING_STATES = new Set([
  "AUTHORISED",
  "AUTHORIZED",
  "PENDING",
  "PROCESSING",
  "CREATED",
  "ACTIVE",
  "INITIATED",
]);

const TERMINAL_FEE_TRIP_STATUSES = new Set([
  "no_show",
  "cancelled",
  "canceled",
  "customer_cancelled",
  "driver_cancelled",
]);

export { TERMINAL_FEE_TRIP_STATUSES };

const DRIVER_EARNING_LEDGER_TYPES = PAYOUT_ELIGIBLE_LEDGER_TYPES;

export type DriverCreditLedgerEntry = {
  type: string;
  amount_pence: number;
  driver_id?: string | null;
};

export type DriverCreditMonitoringInput = {
  financial_model?: string | null;
  trip_status?: string | null;
  trip_driver_id?: string | null;
  driver_net_pence?: number | null;
  tip_pence?: number | null;
  other_driver_entitlement_pence?: number | null;
  ledger?: DriverCreditLedgerEntry[];
  wallet_evidence_available?: boolean;
  provider_state?: string | null;
  captured_pence?: number | null;
  captured_at?: string | null;
  released_pence?: number | null;
  refunded_pence?: number | null;
  /** When set, terminal-fee eligibility uses this + 27h instead of processing grace. */
  fee_charged_at?: string | null;
  is_terminal_fee_session?: boolean;
  now_ms?: number;
  clearing_delay_hours?: number;
};

export function computeExpectedDriverCreditPence(args: {
  driver_net_pence?: number | null;
  tip_pence?: number | null;
  other_driver_entitlement_pence?: number | null;
}): number {
  // Platform-funded promotions must NOT reduce expected driver credit.
  const net = Math.max(0, Math.round(Number(args.driver_net_pence ?? 0)));
  const tips = Math.max(0, Math.round(Number(args.tip_pence ?? 0)));
  const other = Math.max(0, Math.round(Number(args.other_driver_entitlement_pence ?? 0)));
  return net + tips + other;
}

export function sumActiveDriverWalletCreditForTrip(args: {
  ledger?: DriverCreditLedgerEntry[];
  trip_driver_id?: string | null;
}): {
  actual_credit_pence: number;
  correct_driver_credit_pence: number;
  wrong_driver_credit_pence: number;
  earning_entry_count: number;
  has_wrong_driver: boolean;
  has_duplicate: boolean;
} {
  const ledger = args.ledger ?? [];
  const tripDriverId = args.trip_driver_id ?? null;
  let total = 0;
  let correctTotal = 0;
  let wrongTotal = 0;
  let earningCount = 0;
  let wrongCount = 0;

  let tripEarningCount = 0;
  let tipCreditCount = 0;

  for (const entry of ledger) {
    if (!DRIVER_EARNING_LEDGER_TYPES.has(entry.type)) continue;
    if (entry.amount_pence <= 0) continue;
    total += entry.amount_pence;
    earningCount += 1;
    if (entry.type === "TRIP_EARNING_NET") tripEarningCount += 1;
    if (entry.type === "DRIVER_TIP_CREDIT" || entry.type === "TIP_CREDIT") tipCreditCount += 1;
    const entryDriverId = entry.driver_id ?? null;
    if (tripDriverId && entryDriverId && entryDriverId !== tripDriverId) {
      wrongTotal += entry.amount_pence;
      wrongCount += 1;
    } else {
      correctTotal += entry.amount_pence;
    }
  }

  return {
    actual_credit_pence: total,
    correct_driver_credit_pence: correctTotal,
    wrong_driver_credit_pence: wrongTotal,
    earning_entry_count: earningCount,
    has_wrong_driver: wrongCount > 0,
    has_duplicate: tripEarningCount > 1 || tipCreditCount > 1,
  };
}

function parseTimeMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(String(iso));
  return Number.isFinite(ms) ? ms : null;
}

export function resolveDriverCreditEligibilityAt(args: {
  captured_at?: string | null;
  fee_charged_at?: string | null;
  is_terminal_fee_session?: boolean;
  clearing_delay_hours?: number;
}): string | null {
  const delayHours = args.clearing_delay_hours ?? DEFAULT_PAYOUT_CLEARING_DELAY_HOURS;
  if (args.is_terminal_fee_session) {
    const base = parseTimeMs(args.fee_charged_at ?? args.captured_at);
    if (base == null) return null;
    return new Date(base + delayHours * 60 * 60 * 1000).toISOString();
  }
  const capturedAt = parseTimeMs(args.captured_at);
  if (capturedAt == null) return null;
  return new Date(capturedAt + DRIVER_CREDIT_PROCESSING_GRACE_MS).toISOString();
}

function isProviderPending(providerState: string | null | undefined): boolean {
  const state = String(providerState ?? "").trim().toUpperCase();
  if (!state) return false;
  if (state === "CAPTURED" || state === "COMPLETED" || state === "SETTLED") return false;
  return PROVIDER_PENDING_STATES.has(state);
}

function isReleasedOrRefundedWithoutEntitlement(args: {
  expected_credit_pence: number;
  captured_pence?: number | null;
  released_pence?: number | null;
  refunded_pence?: number | null;
  provider_state?: string | null;
}): boolean {
  if (args.expected_credit_pence > 0) return false;
  const provider = String(args.provider_state ?? "").toUpperCase();
  const released = Math.max(0, Number(args.released_pence ?? 0));
  const refunded = Math.max(0, Number(args.refunded_pence ?? 0));
  const captured = args.captured_pence == null ? 0 : Math.max(0, Number(args.captured_pence));
  if (provider === "RELEASED" || provider === "CANCELLED" || provider === "VOIDED") return true;
  if (released > 0 && captured === 0) return true;
  if (refunded > 0 && captured === 0) return true;
  return false;
}

function isBeforeEligibility(args: {
  eligibility_at?: string | null;
  now_ms: number;
}): boolean {
  const at = parseTimeMs(args.eligibility_at);
  if (at == null) return false;
  return args.now_ms < at;
}

/** Canonical driver credit health classifier — FR is primary detection owner. */
export function classifyDriverCreditHealth(
  input: DriverCreditMonitoringInput,
): {
  health: DriverCreditHealth;
  expected_driver_credit_pence: number;
  actual_driver_credit_pence: number;
  credit_difference_pence: number;
  credit_eligibility_at: string | null;
} {
  const nowMs = input.now_ms ?? Date.now();
  const model = String(input.financial_model ?? "").trim().toUpperCase();
  if (model.includes("DRIVER_COLLECTED")) {
    return {
      health: DRIVER_CREDIT_HEALTH.NOT_APPLICABLE,
      expected_driver_credit_pence: 0,
      actual_driver_credit_pence: 0,
      credit_difference_pence: 0,
      credit_eligibility_at: null,
    };
  }

  const expected = computeExpectedDriverCreditPence({
    driver_net_pence: input.driver_net_pence,
    tip_pence: input.tip_pence,
    other_driver_entitlement_pence: input.other_driver_entitlement_pence,
  });

  const tripStatus = String(input.trip_status ?? "").trim().toLowerCase();
  const isTerminalFee = input.is_terminal_fee_session === true
    || TERMINAL_FEE_TRIP_STATUSES.has(tripStatus);

  const eligibilityAt = resolveDriverCreditEligibilityAt({
    captured_at: input.captured_at,
    fee_charged_at: input.fee_charged_at,
    is_terminal_fee_session: isTerminalFee,
    clearing_delay_hours: input.clearing_delay_hours,
  });

  if (isReleasedOrRefundedWithoutEntitlement({
    expected_credit_pence: expected,
    captured_pence: input.captured_pence,
    released_pence: input.released_pence,
    refunded_pence: input.refunded_pence,
    provider_state: input.provider_state,
  })) {
    return {
      health: DRIVER_CREDIT_HEALTH.NOT_APPLICABLE,
      expected_driver_credit_pence: expected,
      actual_driver_credit_pence: 0,
      credit_difference_pence: 0,
      credit_eligibility_at: eligibilityAt,
    };
  }

  if (isProviderPending(input.provider_state)) {
    return {
      health: DRIVER_CREDIT_HEALTH.PENDING,
      expected_driver_credit_pence: expected,
      actual_driver_credit_pence: 0,
      credit_difference_pence: 0,
      credit_eligibility_at: eligibilityAt,
    };
  }

  if (expected === 0) {
    return {
      health: DRIVER_CREDIT_HEALTH.NOT_APPLICABLE,
      expected_driver_credit_pence: 0,
      actual_driver_credit_pence: 0,
      credit_difference_pence: 0,
      credit_eligibility_at: eligibilityAt,
    };
  }

  if (input.wallet_evidence_available === false) {
    return {
      health: DRIVER_CREDIT_HEALTH.PENDING,
      expected_driver_credit_pence: expected,
      actual_driver_credit_pence: 0,
      credit_difference_pence: 0,
      credit_eligibility_at: eligibilityAt,
    };
  }

  const wallet = sumActiveDriverWalletCreditForTrip({
    ledger: input.ledger,
    trip_driver_id: input.trip_driver_id,
  });

  const actual = wallet.correct_driver_credit_pence;
  const difference = actual - expected;

  if (wallet.has_wrong_driver) {
    return {
      health: DRIVER_CREDIT_HEALTH.WRONG_DRIVER,
      expected_driver_credit_pence: expected,
      actual_driver_credit_pence: actual,
      credit_difference_pence: difference,
      credit_eligibility_at: eligibilityAt,
    };
  }

  if (wallet.has_duplicate) {
    return {
      health: DRIVER_CREDIT_HEALTH.DUPLICATE,
      expected_driver_credit_pence: expected,
      actual_driver_credit_pence: actual,
      credit_difference_pence: difference,
      credit_eligibility_at: eligibilityAt,
    };
  }

  if (isBeforeEligibility({ eligibility_at: eligibilityAt, now_ms: nowMs })) {
    return {
      health: DRIVER_CREDIT_HEALTH.PENDING,
      expected_driver_credit_pence: expected,
      actual_driver_credit_pence: actual,
      credit_difference_pence: difference,
      credit_eligibility_at: eligibilityAt,
    };
  }

  if (actual === 0) {
    return {
      health: DRIVER_CREDIT_HEALTH.MISSING,
      expected_driver_credit_pence: expected,
      actual_driver_credit_pence: 0,
      credit_difference_pence: -expected,
      credit_eligibility_at: eligibilityAt,
    };
  }

  if (Math.abs(difference) <= TOLERANCE_PENCE) {
    return {
      health: DRIVER_CREDIT_HEALTH.OK,
      expected_driver_credit_pence: expected,
      actual_driver_credit_pence: actual,
      credit_difference_pence: difference,
      credit_eligibility_at: eligibilityAt,
    };
  }

  if (difference < 0) {
    return {
      health: DRIVER_CREDIT_HEALTH.UNDER_CREDITED,
      expected_driver_credit_pence: expected,
      actual_driver_credit_pence: actual,
      credit_difference_pence: difference,
      credit_eligibility_at: eligibilityAt,
    };
  }

  return {
    health: DRIVER_CREDIT_HEALTH.OVER_CREDITED,
    expected_driver_credit_pence: expected,
    actual_driver_credit_pence: actual,
    credit_difference_pence: difference,
    credit_eligibility_at: eligibilityAt,
  };
}

export function mapDriverCreditHealthToPaymentSessionDisplay(
  health: DriverCreditHealth,
): PaymentSessionDriverCreditDisplay {
  switch (health) {
    case DRIVER_CREDIT_HEALTH.OK:
      return PAYMENT_SESSION_DRIVER_CREDIT_DISPLAY.CREDITED;
    case DRIVER_CREDIT_HEALTH.PENDING:
      return PAYMENT_SESSION_DRIVER_CREDIT_DISPLAY.PENDING;
    case DRIVER_CREDIT_HEALTH.NOT_APPLICABLE:
      return PAYMENT_SESSION_DRIVER_CREDIT_DISPLAY.NOT_APPLICABLE;
    default:
      return PAYMENT_SESSION_DRIVER_CREDIT_DISPLAY.EXCEPTION;
  }
}

export function isDriverCreditExceptionHealth(health: DriverCreditHealth | string | null | undefined): boolean {
  return health === DRIVER_CREDIT_HEALTH.MISSING
    || health === DRIVER_CREDIT_HEALTH.UNDER_CREDITED
    || health === DRIVER_CREDIT_HEALTH.OVER_CREDITED
    || health === DRIVER_CREDIT_HEALTH.DUPLICATE
    || health === DRIVER_CREDIT_HEALTH.WRONG_DRIVER;
}

/** Map canonical health to legacy wallet reconciliation status for existing filters. */
export function mapDriverCreditHealthToWalletReconciliationStatus(
  health: DriverCreditHealth,
): string {
  switch (health) {
    case DRIVER_CREDIT_HEALTH.OK:
      return "WALLET_MATCHED";
    case DRIVER_CREDIT_HEALTH.MISSING:
      return "WALLET_CREDIT_MISSING";
    case DRIVER_CREDIT_HEALTH.UNDER_CREDITED:
      return "WALLET_UNDER_CREDITED";
    case DRIVER_CREDIT_HEALTH.OVER_CREDITED:
      return "WALLET_OVER_CREDITED";
    case DRIVER_CREDIT_HEALTH.DUPLICATE:
      return "WALLET_DUPLICATE";
    case DRIVER_CREDIT_HEALTH.PENDING:
      return "WALLET_PENDING";
    case DRIVER_CREDIT_HEALTH.NOT_APPLICABLE:
      return "WALLET_MATCHED";
    case DRIVER_CREDIT_HEALTH.WRONG_DRIVER:
      return "WALLET_WRONG_DRIVER";
    default:
      return "WALLET_EVIDENCE_UNAVAILABLE";
  }
}

export function aggregateDriverCreditExceptions(
  rows: Array<{
    driver_credit_health?: string | null;
    credit_difference_pence?: number | null;
    expected_driver_credit_pence?: number | null;
    actual_driver_credit_pence?: number | null;
  }>,
): {
  exception_trip_count: number;
  total_difference_pence: number;
} {
  let count = 0;
  let totalDiff = 0;
  for (const row of rows) {
    if (!isDriverCreditExceptionHealth(row.driver_credit_health)) continue;
    count += 1;
    const diff = row.credit_difference_pence ?? (
      (row.actual_driver_credit_pence ?? 0) - (row.expected_driver_credit_pence ?? 0)
    );
    totalDiff += Math.abs(Math.round(Number(diff)));
  }
  return { exception_trip_count: count, total_difference_pence: totalDiff };
}

export type DriverCreditHistoricalAuditReport = {
  eligible_trips: number;
  correctly_credited_trips: number;
  missing_count: number;
  under_credited_count: number;
  over_credited_count: number;
  duplicate_count: number;
  wrong_driver_count: number;
  pending_count: number;
  not_applicable_count: number;
  total_difference_pence: number;
  affected_trip_codes: string[];
};

export function runDriverCreditHistoricalAudit(
  rows: Array<{
    trip_code?: string | null;
    financial_model?: string | null;
    driver_credit_health?: DriverCreditHealth | string | null;
    credit_difference_pence?: number | null;
  }>,
): DriverCreditHistoricalAuditReport {
  const report: DriverCreditHistoricalAuditReport = {
    eligible_trips: 0,
    correctly_credited_trips: 0,
    missing_count: 0,
    under_credited_count: 0,
    over_credited_count: 0,
    duplicate_count: 0,
    wrong_driver_count: 0,
    pending_count: 0,
    not_applicable_count: 0,
    total_difference_pence: 0,
    affected_trip_codes: [],
  };

  for (const row of rows) {
    const model = String(row.financial_model ?? "").trim().toUpperCase();
    const health = String(row.driver_credit_health ?? "") as DriverCreditHealth;

    if (model.includes("DRIVER_COLLECTED") || health === DRIVER_CREDIT_HEALTH.NOT_APPLICABLE) {
      report.not_applicable_count += 1;
      continue;
    }
    if (health === DRIVER_CREDIT_HEALTH.PENDING) {
      report.pending_count += 1;
      continue;
    }

    report.eligible_trips += 1;

    if (health === DRIVER_CREDIT_HEALTH.OK) {
      report.correctly_credited_trips += 1;
      continue;
    }

    const code = row.trip_code?.trim();
    if (code) report.affected_trip_codes.push(code);

    const diff = Math.abs(Math.round(Number(row.credit_difference_pence ?? 0)));
    report.total_difference_pence += diff;

    switch (health) {
      case DRIVER_CREDIT_HEALTH.MISSING:
        report.missing_count += 1;
        break;
      case DRIVER_CREDIT_HEALTH.UNDER_CREDITED:
        report.under_credited_count += 1;
        break;
      case DRIVER_CREDIT_HEALTH.OVER_CREDITED:
        report.over_credited_count += 1;
        break;
      case DRIVER_CREDIT_HEALTH.DUPLICATE:
        report.duplicate_count += 1;
        break;
      case DRIVER_CREDIT_HEALTH.WRONG_DRIVER:
        report.wrong_driver_count += 1;
        break;
      default:
        break;
    }
  }

  return report;
}

export function classifyPayoutCreditIntegrity(args: {
  driver_credit_health?: DriverCreditHealth | string | null;
  wallet_ledger_entry_id?: string | null;
  payout_status?: string | null;
  reservation_status?: string | null;
}): PayoutCreditIntegrityStatus {
  const health = String(args.driver_credit_health ?? "");
  const status = String(args.payout_status ?? "").toLowerCase();
  const reservation = String(args.reservation_status ?? "").toUpperCase();

  if (status.includes("paid") || status.includes("complete") || status.includes("settled")) {
    return PAYOUT_CREDIT_INTEGRITY.PAID;
  }

  if (reservation === "ACTIVE" || reservation === "RESERVED") {
    return PAYOUT_CREDIT_INTEGRITY.PAYOUT_RESERVED;
  }

  if (isDriverCreditExceptionHealth(health)) {
    return PAYOUT_CREDIT_INTEGRITY.CREDIT_EXCEPTION;
  }

  if (health === DRIVER_CREDIT_HEALTH.PENDING) {
    return PAYOUT_CREDIT_INTEGRITY.CREDIT_PENDING;
  }

  if (!args.wallet_ledger_entry_id) {
    return PAYOUT_CREDIT_INTEGRITY.CREDIT_EXCEPTION;
  }

  if (health === DRIVER_CREDIT_HEALTH.OK || health === DRIVER_CREDIT_HEALTH.NOT_APPLICABLE) {
    return PAYOUT_CREDIT_INTEGRITY.WALLET_CREDIT_VERIFIED;
  }

  return PAYOUT_CREDIT_INTEGRITY.CREDIT_PENDING;
}

/** Promotion reconciliation — platform subsidy clears identity mismatch without reducing driver credit. */
export function evaluatePromotionReconciliationIdentity(args: {
  captured_pence: number | null;
  driver_net_pence: number | null;
  commission_pence: number | null;
  airport_fee_pence?: number | null;
  tip_pence?: number | null;
  platform_promotion_subsidy_pence?: number | null;
}): ReturnType<typeof evaluateFrSettlementCaptureIdentity> {
  return evaluateFrSettlementCaptureIdentity({
    captured_pence: args.captured_pence,
    driver_net_pence: args.driver_net_pence,
    commission_pence: args.commission_pence,
    platform_promotion_subsidy_pence: args.platform_promotion_subsidy_pence,
    airport_charge_pence: args.airport_fee_pence,
    tips_pence: args.tip_pence,
  });
}

export const DRIVER_WALLET_MISSING_LEDGER_LABEL =
  "Missing ledger credit — no money entry exists";

export type DriverWalletDiagnosticRow = {
  is_diagnostic_projection: true;
  diagnostic_label: typeof DRIVER_WALLET_MISSING_LEDGER_LABEL;
  trip_id: string | null;
  trip_code: string | null;
  expected_driver_credit_pence: number;
  actual_driver_credit_pence: number;
  credit_difference_pence: number;
  driver_credit_health: DriverCreditHealth;
  credit_eligibility_at: string | null;
  payment_session_id: string | null;
};

export function buildPaymentSessionDriverCreditFields(
  input: DriverCreditMonitoringInput & { purpose?: string | null },
): {
  driver_credit_display: PaymentSessionDriverCreditDisplay;
  driver_credit_health: DriverCreditHealth;
  expected_driver_credit_pence: number;
  actual_driver_credit_pence: number;
  credit_difference_pence: number;
  credit_eligibility_at: string | null;
} {
  const purpose = String(input.purpose ?? "").toUpperCase();
  if (purpose === "SAVE_CARD" || purpose === "LEGACY_EVIDENCE") {
    return {
      driver_credit_display: PAYMENT_SESSION_DRIVER_CREDIT_DISPLAY.NOT_APPLICABLE,
      driver_credit_health: DRIVER_CREDIT_HEALTH.NOT_APPLICABLE,
      expected_driver_credit_pence: 0,
      actual_driver_credit_pence: 0,
      credit_difference_pence: 0,
      credit_eligibility_at: null,
    };
  }

  const credit = classifyDriverCreditHealth(input);
  return {
    driver_credit_display: mapDriverCreditHealthToPaymentSessionDisplay(credit.health),
    driver_credit_health: credit.health,
    expected_driver_credit_pence: credit.expected_driver_credit_pence,
    actual_driver_credit_pence: credit.actual_driver_credit_pence,
    credit_difference_pence: credit.credit_difference_pence,
    credit_eligibility_at: credit.credit_eligibility_at,
  };
}

export function buildMissingLedgerDiagnosticRow(args: {
  trip_id: string | null;
  trip_code?: string | null;
  expected_driver_credit_pence: number;
  driver_credit_health: DriverCreditHealth;
  credit_eligibility_at?: string | null;
  payment_session_id?: string | null;
}): DriverWalletDiagnosticRow | null {
  if (args.driver_credit_health !== DRIVER_CREDIT_HEALTH.MISSING) return null;
  return {
    is_diagnostic_projection: true,
    diagnostic_label: DRIVER_WALLET_MISSING_LEDGER_LABEL,
    trip_id: args.trip_id,
    trip_code: args.trip_code ?? null,
    expected_driver_credit_pence: args.expected_driver_credit_pence,
    actual_driver_credit_pence: 0,
    credit_difference_pence: 0 - args.expected_driver_credit_pence,
    driver_credit_health: args.driver_credit_health,
    credit_eligibility_at: args.credit_eligibility_at ?? null,
    payment_session_id: args.payment_session_id ?? null,
  };
}

/** Driver Wallet audit scopes — read-only; never mutates wallet or payout state. */
export const DRIVER_CREDIT_EXCEPTION_SCOPE = {
  ACTIVE_WALLET_IMPACTING: "ACTIVE_WALLET_IMPACTING",
  PENDING_SETTLEMENT: "PENDING_SETTLEMENT",
  HISTORICAL_AUDIT_BACKLOG: "HISTORICAL_AUDIT_BACKLOG",
  RESOLVED_PAID_HISTORY: "RESOLVED_PAID_HISTORY",
} as const;

export type DriverCreditExceptionScope =
  typeof DRIVER_CREDIT_EXCEPTION_SCOPE[keyof typeof DRIVER_CREDIT_EXCEPTION_SCOPE];

export const DRIVER_CREDIT_EXCEPTION_SCOPE_LABELS: Record<DriverCreditExceptionScope, string> = {
  [DRIVER_CREDIT_EXCEPTION_SCOPE.ACTIVE_WALLET_IMPACTING]: "Active wallet-impacting",
  [DRIVER_CREDIT_EXCEPTION_SCOPE.PENDING_SETTLEMENT]: "Pending settlement",
  [DRIVER_CREDIT_EXCEPTION_SCOPE.HISTORICAL_AUDIT_BACKLOG]: "Historical audit backlog",
  [DRIVER_CREDIT_EXCEPTION_SCOPE.RESOLVED_PAID_HISTORY]: "Resolved / paid history",
};

export const DRIVER_CREDIT_RECOMMENDED_OWNER = {
  SETTLEMENT_REPAIR: "settlement_repair",
  WALLET_ADJUSTMENT: "wallet_adjustment",
  IGNORE_HISTORICAL: "ignore_historical",
  INVESTIGATE: "investigate",
} as const;

export type DriverCreditRecommendedOwner =
  typeof DRIVER_CREDIT_RECOMMENDED_OWNER[keyof typeof DRIVER_CREDIT_RECOMMENDED_OWNER];

export const DRIVER_CREDIT_RECOMMENDED_OWNER_LABELS: Record<DriverCreditRecommendedOwner, string> = {
  [DRIVER_CREDIT_RECOMMENDED_OWNER.SETTLEMENT_REPAIR]: "Settlement repair",
  [DRIVER_CREDIT_RECOMMENDED_OWNER.WALLET_ADJUSTMENT]: "Wallet adjustment (approved only)",
  [DRIVER_CREDIT_RECOMMENDED_OWNER.IGNORE_HISTORICAL]: "Ignore historical",
  [DRIVER_CREDIT_RECOMMENDED_OWNER.INVESTIGATE]: "Investigate",
};

const ALWAYS_ACTIVE_EXCEPTION_HEALTH = new Set<string>([
  DRIVER_CREDIT_HEALTH.DUPLICATE,
  DRIVER_CREDIT_HEALTH.OVER_CREDITED,
  DRIVER_CREDIT_HEALTH.WRONG_DRIVER,
]);

const RESOLVED_SETTLEMENT_MARKERS = [
  "PAID_OUT",
  "PAYOUT_COMPLETED",
  "PAYOUT_PAID",
  "FULLY_PAID",
  "ALLOCATED_TO_PAYOUT",
  "PAID_IN_PAYOUT",
] as const;

export type DriverWalletCreditAuditInputRow = {
  trip_id?: string | null;
  trip_code?: string | null;
  driver_credit_health?: string | null;
  expected_driver_credit_pence?: number | null;
  actual_driver_credit_pence?: number | null;
  credit_difference_pence?: number | null;
  credit_eligibility_at?: string | null;
  settlement_status?: string | null;
  completed_at?: string | null;
  payout_status?: string | null;
  wallet_payout_blocked?: boolean | null;
};

export type DriverWalletCreditAuditRow = {
  trip_id: string | null;
  trip_code: string | null;
  driver_credit_health: string;
  expected_driver_credit_pence: number | null;
  actual_driver_credit_pence: number | null;
  credit_difference_pence: number | null;
  scope: DriverCreditExceptionScope;
  active_wallet_impact: boolean;
  recommended_owner: DriverCreditRecommendedOwner;
  classification_label: string;
};

export type DriverWalletCreditAuditSummary = {
  total_audit_items: number;
  active_wallet_impacting_count: number;
  pending_settlement_count: number;
  historical_backlog_count: number;
  resolved_paid_count: number;
  /** Sum |variance| for ACTIVE scope only — never a live balance/debt headline. */
  active_balance_variance_pence: number;
  show_blocking_alert: boolean;
};

function isCreditEligibilityPassed(args: {
  credit_eligibility_at?: string | null;
  now_ms: number;
}): boolean {
  const at = parseTimeMs(args.credit_eligibility_at);
  if (at == null) return true;
  return args.now_ms >= at;
}

function isResolvedPaidCreditHistory(args: {
  driver_credit_health?: string | null;
  settlement_status?: string | null;
  payout_status?: string | null;
}): boolean {
  const health = String(args.driver_credit_health ?? "");
  if (ALWAYS_ACTIVE_EXCEPTION_HEALTH.has(health)) return false;

  const payout = String(args.payout_status ?? "").trim().toLowerCase();
  if (
    payout.includes("paid")
    || payout.includes("complete")
    || payout.includes("settled")
    || payout.includes("succeeded")
  ) {
    return true;
  }

  const settlement = String(args.settlement_status ?? "").trim().toUpperCase();
  if (!settlement) return false;
  return RESOLVED_SETTLEMENT_MARKERS.some((marker) => settlement.includes(marker));
}

function isActiveWalletImpactingCreditException(args: {
  driver_credit_health?: string | null;
  credit_eligibility_at?: string | null;
  settlement_status?: string | null;
  payout_status?: string | null;
  expected_driver_credit_pence?: number | null;
  actual_driver_credit_pence?: number | null;
  credit_difference_pence?: number | null;
  wallet_payout_blocked?: boolean | null;
  now_ms: number;
}): boolean {
  const health = String(args.driver_credit_health ?? "");
  if (ALWAYS_ACTIVE_EXCEPTION_HEALTH.has(health)) return true;
  if (!isDriverCreditExceptionHealth(health)) return false;
  if (!isCreditEligibilityPassed(args)) return false;
  if (isResolvedPaidCreditHistory(args)) return false;

  const expected = Math.round(Number(args.expected_driver_credit_pence ?? 0));
  const actual = Math.round(Number(args.actual_driver_credit_pence ?? 0));
  const diff = args.credit_difference_pence == null
    ? actual - expected
    : Math.round(Number(args.credit_difference_pence));

  if (health === DRIVER_CREDIT_HEALTH.MISSING || health === DRIVER_CREDIT_HEALTH.UNDER_CREDITED) {
    return diff < -1;
  }

  return args.wallet_payout_blocked === true;
}

export function resolveDriverCreditRecommendedOwner(args: {
  scope: DriverCreditExceptionScope;
  driver_credit_health?: string | null;
}): DriverCreditRecommendedOwner {
  const health = String(args.driver_credit_health ?? "");
  if (
    args.scope === DRIVER_CREDIT_EXCEPTION_SCOPE.RESOLVED_PAID_HISTORY
    || args.scope === DRIVER_CREDIT_EXCEPTION_SCOPE.HISTORICAL_AUDIT_BACKLOG
  ) {
    return DRIVER_CREDIT_RECOMMENDED_OWNER.IGNORE_HISTORICAL;
  }
  if (args.scope === DRIVER_CREDIT_EXCEPTION_SCOPE.PENDING_SETTLEMENT) {
    return DRIVER_CREDIT_RECOMMENDED_OWNER.SETTLEMENT_REPAIR;
  }
  if (
    health === DRIVER_CREDIT_HEALTH.DUPLICATE
    || health === DRIVER_CREDIT_HEALTH.WRONG_DRIVER
    || health === DRIVER_CREDIT_HEALTH.OVER_CREDITED
  ) {
    return DRIVER_CREDIT_RECOMMENDED_OWNER.INVESTIGATE;
  }
  if (
    health === DRIVER_CREDIT_HEALTH.MISSING
    || health === DRIVER_CREDIT_HEALTH.UNDER_CREDITED
  ) {
    return DRIVER_CREDIT_RECOMMENDED_OWNER.SETTLEMENT_REPAIR;
  }
  return DRIVER_CREDIT_RECOMMENDED_OWNER.INVESTIGATE;
}

/** Classify one settlement/credit row into an audit scope (read-only). */
export function classifyDriverCreditExceptionScope(
  args: DriverWalletCreditAuditInputRow & { now_ms?: number },
): DriverCreditExceptionScope | null {
  const health = String(args.driver_credit_health ?? "");
  if (health === DRIVER_CREDIT_HEALTH.NOT_APPLICABLE || health === DRIVER_CREDIT_HEALTH.OK) {
    return null;
  }

  const nowMs = args.now_ms ?? Date.now();

  if (health === DRIVER_CREDIT_HEALTH.PENDING) {
    return DRIVER_CREDIT_EXCEPTION_SCOPE.PENDING_SETTLEMENT;
  }

  if (!isDriverCreditExceptionHealth(health)) return null;

  if (isResolvedPaidCreditHistory(args)) {
    return DRIVER_CREDIT_EXCEPTION_SCOPE.RESOLVED_PAID_HISTORY;
  }

  if (isActiveWalletImpactingCreditException({ ...args, now_ms: nowMs })) {
    return DRIVER_CREDIT_EXCEPTION_SCOPE.ACTIVE_WALLET_IMPACTING;
  }

  if (!isCreditEligibilityPassed({ credit_eligibility_at: args.credit_eligibility_at, now_ms: nowMs })) {
    return DRIVER_CREDIT_EXCEPTION_SCOPE.PENDING_SETTLEMENT;
  }

  return DRIVER_CREDIT_EXCEPTION_SCOPE.HISTORICAL_AUDIT_BACKLOG;
}

export function buildDriverWalletCreditAuditRow(
  input: DriverWalletCreditAuditInputRow & { now_ms?: number },
): DriverWalletCreditAuditRow | null {
  const scope = classifyDriverCreditExceptionScope(input);
  if (!scope) return null;

  const health = String(input.driver_credit_health ?? "");
  const expected = input.expected_driver_credit_pence == null
    ? null
    : Math.round(Number(input.expected_driver_credit_pence));
  const actual = input.actual_driver_credit_pence == null
    ? null
    : Math.round(Number(input.actual_driver_credit_pence));
  const diff = input.credit_difference_pence == null
    ? (expected == null || actual == null ? null : actual - expected)
    : Math.round(Number(input.credit_difference_pence));

  const active = scope === DRIVER_CREDIT_EXCEPTION_SCOPE.ACTIVE_WALLET_IMPACTING;
  const recommended_owner = resolveDriverCreditRecommendedOwner({ scope, driver_credit_health: health });

  return {
    trip_id: input.trip_id ?? null,
    trip_code: input.trip_code ?? null,
    driver_credit_health: health,
    expected_driver_credit_pence: expected,
    actual_driver_credit_pence: actual,
    credit_difference_pence: diff,
    scope,
    active_wallet_impact: active,
    recommended_owner,
    classification_label: `${DRIVER_CREDIT_EXCEPTION_SCOPE_LABELS[scope]} · ${health}`,
  };
}

export function buildDriverWalletCreditAuditSummary(
  rows: ReadonlyArray<DriverWalletCreditAuditRow>,
): DriverWalletCreditAuditSummary {
  let active_wallet_impacting_count = 0;
  let pending_settlement_count = 0;
  let historical_backlog_count = 0;
  let resolved_paid_count = 0;
  let active_balance_variance_pence = 0;

  for (const row of rows) {
    switch (row.scope) {
      case DRIVER_CREDIT_EXCEPTION_SCOPE.ACTIVE_WALLET_IMPACTING:
        active_wallet_impacting_count += 1;
        active_balance_variance_pence += Math.abs(Math.round(Number(row.credit_difference_pence ?? 0)));
        break;
      case DRIVER_CREDIT_EXCEPTION_SCOPE.PENDING_SETTLEMENT:
        pending_settlement_count += 1;
        break;
      case DRIVER_CREDIT_EXCEPTION_SCOPE.HISTORICAL_AUDIT_BACKLOG:
        historical_backlog_count += 1;
        break;
      case DRIVER_CREDIT_EXCEPTION_SCOPE.RESOLVED_PAID_HISTORY:
        resolved_paid_count += 1;
        break;
      default:
        break;
    }
  }

  return {
    total_audit_items: rows.length,
    active_wallet_impacting_count,
    pending_settlement_count,
    historical_backlog_count,
    resolved_paid_count,
    active_balance_variance_pence,
    show_blocking_alert: active_wallet_impacting_count > 0,
  };
}

export function buildDriverWalletCreditAuditFromSettlementRows(
  rows: ReadonlyArray<DriverWalletCreditAuditInputRow>,
  args?: { now_ms?: number },
): {
  rows: DriverWalletCreditAuditRow[];
  summary: DriverWalletCreditAuditSummary;
} {
  const auditRows: DriverWalletCreditAuditRow[] = [];
  for (const row of rows) {
    const built = buildDriverWalletCreditAuditRow({ ...row, now_ms: args?.now_ms });
    if (built) auditRows.push(built);
  }
  return {
    rows: auditRows,
    summary: buildDriverWalletCreditAuditSummary(auditRows),
  };
}
