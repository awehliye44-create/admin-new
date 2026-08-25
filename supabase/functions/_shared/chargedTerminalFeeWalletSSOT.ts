/**
 * Charged terminal fee wallet SSOT.
 *
 * Policy:
 * - No-show / late passenger / airport-protection / other configured terminal fees are NOT commissionable.
 * - ONECAB commission = 0p.
 * - Provider acquiring fee is NOT paid by ONECAB; it stays on Payment Sessions reporting.
 * - Driver TEN = captured_amount_pence − actual provider_processing_fee_pence (known only).
 * - Missing/unknown provider fee → fail closed (no TEN invent); FR must detect.
 * - Computed TEN ≤ 0 → fail closed (do not post negative/zero TEN).
 * - economic_earned_at from Payment Sessions captured_at (27h clearing).
 * - Zero-fee released cancellation → no TEN.
 * - Completed rides keep normal commission / driver_net settlement (out of scope here).
 */
export const CHARGED_FEE_OUTCOMES = [
  "NO_SHOW",
  "LATE_PASSENGER_CANCELLATION",
  "AIRPORT_PROTECTION_CANCELLATION",
  "CANCELLED_WITH_FEE",
] as const;

export type ChargedFeeOutcome = (typeof CHARGED_FEE_OUTCOMES)[number];

const NON_FEE_OUTCOMES = new Set([
  "COMPLETED",
  "CANCELLED_NO_FEE",
  "",
]);

/** Named outcomes plus any *CANCELLATION / WITH_FEE terminal fee stamp. */
export function isChargedFeeOutcome(outcome: string | null | undefined): outcome is ChargedFeeOutcome | string {
  const o = String(outcome ?? "").trim().toUpperCase();
  if (!o || NON_FEE_OUTCOMES.has(o)) return false;
  if ((CHARGED_FEE_OUTCOMES as readonly string[]).includes(o)) return true;
  if (o.includes("NO_SHOW")) return true;
  if (o.includes("CANCELLATION") || o.includes("PROTECTION")) return true;
  if (o === "CANCELLED_WITH_FEE") return true;
  return false;
}

/**
 * Map cancel-trip / disposer fee_type → canonical financial_outcome for RFO.
 * Generic configured cancellation fees land on CANCELLED_WITH_FEE.
 * Returns null when fee_type is none / empty (no charged-fee settlement).
 */
export function mapFeeTypeToChargedOutcome(feeType: string | null | undefined): string | null {
  const t = String(feeType ?? "").trim().toLowerCase();
  if (!t || t === "none") return null;
  if (t === "no_show" || t === "customer_no_show") return "NO_SHOW";
  if (
    t === "late_cancellation" ||
    t === "late_passenger_cancellation" ||
    t === "late_cancel"
  ) {
    return "LATE_PASSENGER_CANCELLATION";
  }
  if (t === "airport_protection" || t === "airport_protection_cancellation") {
    return "AIRPORT_PROTECTION_CANCELLATION";
  }
  if (
    t === "cancellation" ||
    t === "arrival_cancellation" ||
    t === "other_cancellation" ||
    t === "protection"
  ) {
    return "CANCELLED_WITH_FEE";
  }
  return "CANCELLED_WITH_FEE";
}

/** fare_pricing_settings columns for airport/long-distance cancel protection. */
export type AirportProtectionFeeConfig = {
  late_cancel_airport_protection_enabled?: boolean | null;
  late_cancel_airport_fare_threshold_pence?: number | null;
  late_cancel_airport_fee_type?: string | null;
  late_cancel_airport_fee_percentage?: number | null;
  late_cancel_airport_protection_trigger?: string | null;
};

/**
 * Pure: airport/long-distance protection fee from admin config + trip evidence.
 * Fee = percentage of estimated fare when journey-to-pickup started and fare ≥ threshold.
 * Pre-arrival only — post-arrival uses arrival/standard cancellation fees.
 */
export function resolveAirportProtectionCancelFee(args: {
  config: AirportProtectionFeeConfig | null | undefined;
  driverStartedJourneyToPickupAt?: string | null;
  estimatedFarePence?: number | null;
  arrivedAt?: string | null;
}): { applies: boolean; feePence: number; reason: string; percentage: number } {
  const config = args.config;
  if (!config || config.late_cancel_airport_protection_enabled !== true) {
    return { applies: false, feePence: 0, reason: "disabled", percentage: 0 };
  }
  if (args.arrivedAt) {
    return { applies: false, feePence: 0, reason: "already_arrived", percentage: 0 };
  }
  const trigger = String(
    config.late_cancel_airport_protection_trigger ?? "AFTER_DRIVER_STARTED_JOURNEY",
  ).toUpperCase();
  if (
    trigger === "AFTER_DRIVER_STARTED_JOURNEY" &&
    !(typeof args.driverStartedJourneyToPickupAt === "string" &&
      args.driverStartedJourneyToPickupAt.trim())
  ) {
    return { applies: false, feePence: 0, reason: "journey_not_started", percentage: 0 };
  }
  const fare = Math.max(0, Math.round(Number(args.estimatedFarePence) || 0));
  const threshold = Math.max(0, Math.round(Number(config.late_cancel_airport_fare_threshold_pence) || 0));
  if (fare < threshold) {
    return { applies: false, feePence: 0, reason: "below_fare_threshold", percentage: 0 };
  }
  const feeType = String(config.late_cancel_airport_fee_type ?? "PERCENTAGE").toUpperCase();
  if (feeType !== "PERCENTAGE") {
    return { applies: false, feePence: 0, reason: "unsupported_fee_type", percentage: 0 };
  }
  const percentage = Math.max(0, Math.round(Number(config.late_cancel_airport_fee_percentage) || 0));
  if (percentage <= 0) {
    return { applies: false, feePence: 0, reason: "zero_percentage", percentage: 0 };
  }
  const feePence = Math.round((fare * percentage) / 100);
  if (feePence <= 0) {
    return { applies: false, feePence: 0, reason: "zero_fee", percentage };
  }
  return { applies: true, feePence, reason: "airport_protection", percentage };
}

function nonEmptyUuidish(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  return t.length > 0 ? t : null;
}

/**
 * Prefer confirmed assignment when trips.driver_id was cleared / null.
 * Optional FR-detect-only evidence (accepted offer / audit) fills gaps after cancel
 * triggers null trip.driver_id — never used by wallet writers unless they pass it.
 */
export function resolveAssignedDriverId(args: {
  driver_id?: string | null;
  confirmed_driver_id?: string | null;
  /** FR detect only — ride_offers.driver_id from accepted / linked offer. */
  accepted_offer_driver_id?: string | null;
  /** FR detect only — unambiguous assignment audit / dispatch breadcrumb. */
  assignment_evidence_driver_id?: string | null;
}): string | null {
  return (
    nonEmptyUuidish(args.confirmed_driver_id) ??
    nonEmptyUuidish(args.driver_id) ??
    nonEmptyUuidish(args.accepted_offer_driver_id) ??
    nonEmptyUuidish(args.assignment_evidence_driver_id)
  );
}

/**
 * Collapse optional FR evidence driver ids to a single assignee, or null if conflicting/empty.
 * Classification only — does not post wallet money.
 */
export function resolveUnambiguousEvidenceDriverId(
  evidenceDriverIds: Array<string | null | undefined>,
): string | null {
  const uniq = [
    ...new Set(
      evidenceDriverIds
        .map((id) => nonEmptyUuidish(id))
        .filter((id): id is string => id != null),
    ),
  ];
  return uniq.length === 1 ? uniq[0] : null;
}

export type ChargedFeeRevenueType =
  | "no_show_revenue"
  | "late_cancellation_revenue"
  | "airport_protection_revenue"
  | "terminal_cancellation_revenue";

export function resolveChargedFeeRevenueType(
  outcome: string | null | undefined,
): ChargedFeeRevenueType {
  const o = String(outcome ?? "").toUpperCase();
  if (o.includes("NO_SHOW")) return "no_show_revenue";
  if (o.includes("LATE_PASSENGER") || o.includes("LATE_CANCEL")) {
    return "late_cancellation_revenue";
  }
  if (o.includes("AIRPORT") || o.includes("PROTECTION")) {
    return "airport_protection_revenue";
  }
  return "terminal_cancellation_revenue";
}

/**
 * Read Payment Session provider_processing_fee_pence as a *known* value.
 * null / undefined / non-finite / negative → unknown (fail closed — never invent 0).
 * Explicit 0 is known only when paired with fee_status ACTUAL (see readKnownActualProviderFeePence).
 */
export function readKnownProviderFeePence(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string" && raw.trim() === "") return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

/** Payment Sessions confirmed provider fee — only ACTUAL is authoritative for TEN. */
export function isActualProviderFeeStatus(raw: unknown): boolean {
  return String(raw ?? "").trim().toUpperCase() === "ACTUAL";
}

/**
 * Known provider fee for terminal-fee TEN: pence present AND fee_status === ACTUAL.
 * PENDING / UNAVAILABLE / null status / missing pence → fail closed (never invent).
 */
export function readKnownActualProviderFeePence(args: {
  providerFeePence: unknown;
  feeStatus: unknown;
}): number | null {
  if (!isActualProviderFeeStatus(args.feeStatus)) return null;
  return readKnownProviderFeePence(args.providerFeePence);
}

/**
 * Authoritative driver entitlement for a provider-captured terminal fee.
 * TEN = captured fee − known ACTUAL provider fee; commission always 0.
 * Never invent provider fee; never post non-positive TEN.
 */
export function resolveChargedTerminalFeeEntitlement(args: {
  outcome: ChargedFeeOutcome | string;
  /** Provider-captured terminal fee (PS captured_amount_pence preferred). */
  feePence: number;
  /**
   * Actual Payment Session provider_processing_fee_pence.
   * Must be a known number (including 0). null/undefined → fail closed.
   */
  providerFeePence: number | null | undefined;
  /**
   * Payment Session fee_status — must be ACTUAL (case-insensitive).
   * Missing / PENDING / UNAVAILABLE → fail closed even if pence is present.
   */
  feeStatus: unknown;
}): {
  ok: true;
  captured_fee_pence: number;
  provider_fee_pence: number;
  driver_net_pence: number;
  commission_pence: number;
  commission_pct: number;
  revenue_type: ChargedFeeRevenueType;
} | {
  ok: false;
  reason: string;
} {
  if (!isChargedFeeOutcome(args.outcome)) {
    return { ok: false, reason: `outcome_not_charged_fee:${args.outcome}` };
  }
  const captured = Math.round(Number(args.feePence) || 0);
  if (!Number.isFinite(captured) || captured <= 0) {
    return { ok: false, reason: "fee_pence_must_be_positive" };
  }
  const providerFee = readKnownActualProviderFeePence({
    providerFeePence: args.providerFeePence,
    feeStatus: args.feeStatus,
  });
  if (providerFee == null) {
    return { ok: false, reason: "provider_fee_unknown" };
  }
  const driverNet = captured - providerFee;
  if (!Number.isFinite(driverNet) || driverNet <= 0) {
    return { ok: false, reason: "driver_ten_non_positive" };
  }
  return {
    ok: true,
    captured_fee_pence: captured,
    provider_fee_pence: providerFee,
    driver_net_pence: driverNet,
    commission_pence: 0,
    commission_pct: 0,
    revenue_type: resolveChargedFeeRevenueType(args.outcome),
  };
}

/** Local Payment Session patch after provider fee capture (not release-only cancel). */
export function buildFeeCapturePaymentSessionPatch(args: {
  authPence: number;
  capturedFeePence: number;
  providerState: string;
  capturedAtIso: string;
}): {
  provider_state: string;
  status: "captured" | "cancelled";
  financial_operation_state: "CAPTURED" | null;
  captured_amount_pence: number;
  released_amount_pence: number;
  captured_at: string | null;
  released_at: string | null;
  hold_release_state: "released" | null;
  hold_terminal_reason: string;
} {
  const auth = Math.max(0, Math.round(Number(args.authPence) || 0));
  const captured = Math.max(0, Math.round(Number(args.capturedFeePence) || 0));
  const released = Math.max(0, auth - captured);
  if (captured > 0) {
    return {
      provider_state: args.providerState,
      status: "captured",
      financial_operation_state: "CAPTURED",
      captured_amount_pence: captured,
      released_amount_pence: released,
      captured_at: args.capturedAtIso,
      released_at: released > 0 ? args.capturedAtIso : null,
      hold_release_state: released > 0 ? "released" : null,
      hold_terminal_reason: "terminal_fee_partial_capture",
    };
  }
  return {
    provider_state: args.providerState,
    status: "cancelled",
    financial_operation_state: null,
    captured_amount_pence: 0,
    released_amount_pence: auth,
    captured_at: null,
    released_at: args.capturedAtIso,
    hold_release_state: "released",
    hold_terminal_reason: "terminal_no_fee_void",
  };
}

export function chargedFeeOutcomeLabel(outcome: string | null | undefined): string {
  const o = String(outcome ?? "").toUpperCase();
  if (o.includes("NO_SHOW")) return "no-show";
  if (o.includes("LATE_PASSENGER") || o.includes("LATE_CANCEL")) return "late cancellation";
  if (o.includes("AIRPORT") || o.includes("PROTECTION")) return "airport protection cancellation";
  return "terminal cancellation";
}

export function buildChargedFeeTenLedgerInsert(args: {
  driverId: string;
  tripId: string;
  /** Fee-net TEN (captured − provider fee). */
  feePence: number;
  currency: string;
  outcome: ChargedFeeOutcome | string;
  capturedFeePence?: number;
  providerFeePence?: number;
}): Record<string, unknown> {
  const label = chargedFeeOutcomeLabel(args.outcome);
  const captured = args.capturedFeePence != null
    ? Math.round(Number(args.capturedFeePence) || 0)
    : null;
  const providerFee = args.providerFeePence != null
    ? Math.round(Number(args.providerFeePence) || 0)
    : null;
  const detail = captured != null && providerFee != null
    ? ` (captured ${captured}p − provider fee ${providerFee}p)`
    : "";
  return {
    driver_id: args.driverId,
    related_trip_id: args.tripId,
    type: "TRIP_EARNING_NET",
    amount_pence: Math.round(Number(args.feePence) || 0),
    currency: args.currency,
    description:
      `Driver compensation from ${label} fee${detail}; commission 0; provider fee not paid by ONECAB`,
  };
}

/** True when dispose outcome proves provider captured a positive fee (no second capture). */
export function disposeOutcomeIndicatesFeeCapture(disposition: {
  outcome?: string | null;
  captured_fee_pence?: number | null;
  provider_state?: string | null;
} | null | undefined): boolean {
  if (!disposition) return false;
  // Authoritative proof is captured_fee_pence > 0 — never TEN on outcome string alone.
  return Math.round(Number(disposition.captured_fee_pence) || 0) > 0;
}

export type ChargedFeeTenPostStatus =
  | "NOT_REQUIRED"
  | "SUCCEEDED"
  | "FAILED"
  | "SKIPPED_NO_DRIVER";

export type ChargedFeeTenPostResult = {
  status: ChargedFeeTenPostStatus;
  error?: string | null;
};

/**
 * Post Driver Wallet TEN via record-financial-outcome after proven fee capture.
 * Idempotent at RFO (existing matching TEN → success). Never triggers a second provider capture.
 * RFO computes fee-net TEN from PS captured − known provider fee (fail closed if unknown).
 */
export async function postChargedFeeTenViaRfo(args: {
  supabaseUrl: string;
  serviceRoleKey: string;
  tripId: string;
  driverId: string | null | undefined;
  outcome: string;
  feePence: number;
  paymentMethod?: string | null;
  economicEarnedAt?: string | null;
  disposition?: {
    captured_fee_pence?: number | null;
    captured_at?: string | null;
  } | null;
}): Promise<ChargedFeeTenPostResult> {
  if (args.disposition != null && !disposeOutcomeIndicatesFeeCapture(args.disposition)) {
    return { status: "NOT_REQUIRED" };
  }
  const captured = Math.round(
    Number(args.disposition?.captured_fee_pence) || Number(args.feePence) || 0,
  );
  if (captured <= 0) return { status: "NOT_REQUIRED" };

  const driverId = typeof args.driverId === "string" && args.driverId.trim()
    ? args.driverId.trim()
    : null;
  if (!driverId) {
    return { status: "SKIPPED_NO_DRIVER", error: "missing_assigned_driver_for_fee_settlement" };
  }

  const outcome = isChargedFeeOutcome(args.outcome)
    ? String(args.outcome).trim().toUpperCase()
    : "CANCELLED_WITH_FEE";

  try {
    const rfoRes = await fetch(`${args.supabaseUrl}/functions/v1/record-financial-outcome`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${args.serviceRoleKey}`,
      },
      body: JSON.stringify({
        trip_id: args.tripId,
        driver_id: driverId,
        outcome,
        fee_pence: captured,
        payment_method: args.paymentMethod || "unknown",
        economic_earned_at:
          (typeof args.disposition?.captured_at === "string" && args.disposition.captured_at) ||
          args.economicEarnedAt ||
          null,
      }),
    });
    const rfoBody = await rfoRes.json().catch(() => ({}));
    if (rfoRes.ok && (rfoBody as { success?: boolean })?.success === true) {
      return { status: "SUCCEEDED" };
    }
    return {
      status: "FAILED",
      error:
        typeof (rfoBody as { error?: string })?.error === "string"
          ? (rfoBody as { error: string }).error
          : typeof (rfoBody as { error_code?: string })?.error_code === "string"
          ? (rfoBody as { error_code: string }).error_code
          : `rfo_http_${rfoRes.status}`,
    };
  } catch (e) {
    return {
      status: "FAILED",
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/** Non-completed trip statuses that may carry a captured terminal fee. */
export function isNonCompletedTerminalTripStatus(status: string | null | undefined): boolean {
  const s = String(status ?? "").toLowerCase().replace(/-/g, "_");
  return (
    s === "no_show" ||
    s === "cancelled" ||
    s === "canceled" ||
    s === "customer_cancelled" ||
    s === "customer_canceled"
  );
}
