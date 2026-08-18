/**
 * Historical wallet recovery entry point for PLATFORM_COLLECTED trips that were
 * captured but never received a TRIP_EARNING_NET wallet credit.
 *
 * HARD RESTRICTIONS:
 * - Never calls Revolut or any payment provider.
 * - Never captures, refunds, or releases money.
 * - Never recalculates settlement — reads saved driver_net_pence + airport_charge_pence only.
 * - Never processes a trip not in the explicit allow-list.
 * - Idempotent: if TRIP_EARNING_NET already exists, returns { skipped: true }.
 * - Activating this recovery for any trip requires explicit approval.
 *
 * Usage:
 *   const result = await recoverCapturedTripWallet(supabase, {
 *     tripId: "...",
 *     allowedTripIds: APPROVED_RECOVERY_TRIP_IDS,
 *   });
 *
 * Dry-run mode (default):
 *   Pass dryRun: true (or omit) to simulate without DB writes.
 *
 * Lock: capturedTripWalletRecoveryLock.test.ts
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  finalizePaymentSessionLifecycleMismatch,
  checkPsLifecycleFinalizerPreconditions,
} from "./paymentSessionLifecycleFinalizer.ts";
import {
  loadWalletRecoveryPaymentSessions,
  type PaymentSessionGateRow,
} from "./paymentSessionCaptureGateSSOT.ts";
import {
  isPaymentSessionLifecycleMismatch,
  paymentSessionAllowsWalletPosting,
} from "./postCaptureSettlementBoundary.ts";
import { creditCapturedCardTripLedger } from "./onecabFinanceLedger.ts";
import { SERVICE_AREA_FINANCIAL_MODEL } from "./commissionWalletSSOT.ts";
import { classifyFrPromotionApplication } from "./frPerTripAuditSSOT.ts";
import { DEFAULT_PAYOUT_CLEARING_DELAY_HOURS } from "./driverPayoutEligibilitySSOT.ts";
import {
  calculateTripSettlementFromTripRow,
  type TripSettlementTripRow,
} from "./tripSettlement.ts";

/** Explicit Step 3 allow-list. No cohort / date-range recovery. */
export const APPROVED_CAPTURED_TRIP_WALLET_RECOVERY_TRIP_IDS = [
  "3a575bad-ce3d-491e-998a-cd83fa5256ea", // MK-260818-002
  "7ada43fa-1f3d-43e8-979b-6152ba9d5f2c", // MK-260818-003
] as const;

export const RECOVERY_AUDIT_REASON = "VERIFIED_CAPTURE_MISSING_TRIP_EARNING_NET";

export type CapturedTripWalletRecoveryDryRunEligible = {
  status: "DRY_RUN_ELIGIBLE";
  expected_credit_pence: number;
  session_status: string;
  payment_session_id: string | null;
  provider_capture_id: string | null;
  provider_order_id: string | null;
  driver_id: string;
  existing_wallet_count: number;
  existing_wallet_amount_pence: number;
  proposed_ledger_type: "TRIP_EARNING_NET";
  proposed_amount_pence: number;
  currency: string;
  proposed_related_trip_id: string;
  proposed_description: string;
  captured_at: string | null;
  eligible_at: string | null;
  eligibility_classification: "Pending" | "Available";
  provider_operation_required: false;
  settlement_recalculation_required: false;
};

export type CapturedTripWalletRecoveryResult = {
  tripId: string;
  tripCode: string | null;
  dryRun: boolean;
} & (
  | { status: "NOT_IN_ALLOW_LIST" }
  | { status: "TRIP_NOT_FOUND" }
  | { status: "TRIP_NOT_COMPLETED"; trip_status: string }
  | { status: "FINANCIAL_MODEL_VIOLATION"; financial_model: string }
  | { status: "NO_DRIVER_ID" }
  | { status: "NO_SAVED_ENTITLEMENT" }
  | {
    status: "SETTLEMENT_CORRECTION_REQUIRED";
    reason: string;
    saved_driver_net_pence: number | null;
    canonical_driver_net_pence: number | null;
    driver_net_difference_pence: number | null;
    saved_commissionable_fare_pence: number | null;
    canonical_commissionable_fare_pence: number | null;
    canonical_commission_pence: number | null;
  }
  | { status: "PAYMENT_SESSION_NOT_FOUND" }
  | { status: "PAYMENT_SESSION_BLOCKED"; reason: string }
  | { status: "MODEL_ISOLATION_BLOCKED"; reason: string }
  | { status: "LIFECYCLE_FINALIZATION_FAILED"; reason: string }
  | { status: "ALREADY_CREDITED"; credited_pence: number }
  | { status: "WALLET_AMOUNT_MISMATCH"; expected_pence: number; actual_pence: number }
  | { status: "DUPLICATE_WALLET_CREDIT"; existing_count: number }
  | CapturedTripWalletRecoveryDryRunEligible
  | { status: "DRY_RUN"; expected_credit_pence: number; session_status: string }
  | { status: "CREDITED"; credited_pence: number }
  | { status: "CREDIT_FAILED"; error: string }
);

type SettlementCorrectionRequiredResult = {
  status: "SETTLEMENT_CORRECTION_REQUIRED";
  reason: string;
  saved_driver_net_pence: number | null;
  canonical_driver_net_pence: number | null;
  driver_net_difference_pence: number | null;
  saved_commissionable_fare_pence: number | null;
  canonical_commissionable_fare_pence: number | null;
  canonical_commission_pence: number | null;
};

function safePence(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.round(n));
}

function commissionRatePresent(trip: Record<string, unknown>): boolean {
  const pct = trip.accepted_commission_percent ?? trip.commission_pct ?? trip.driver_tier_commission_percent;
  if (pct == null) return false;
  const n = Number(pct);
  return Number.isFinite(n) && n > 0;
}

function assessHistoricalRecoverySettlementSafety(
  trip: Record<string, unknown>,
): SettlementCorrectionRequiredResult | null {
  const savedDriverNet = safePence(trip.driver_net_pence);
  const savedCommissionable = safePence(trip.commissionable_fare_pence);
  const promo = classifyFrPromotionApplication(trip as Parameters<typeof classifyFrPromotionApplication>[0]);

  if (!commissionRatePresent(trip)) {
    return {
      status: "SETTLEMENT_CORRECTION_REQUIRED",
      reason: "PENDING_EVIDENCE: accepted commission rate missing from saved settlement evidence",
      saved_driver_net_pence: savedDriverNet,
      canonical_driver_net_pence: null,
      driver_net_difference_pence: null,
      saved_commissionable_fare_pence: savedCommissionable,
      canonical_commissionable_fare_pence: promo.canonical_commissionable_fare_pence,
      canonical_commission_pence: null,
    };
  }

  if (promo.promotion_application_status === "PENDING_EVIDENCE") {
    return {
      status: "SETTLEMENT_CORRECTION_REQUIRED",
      reason: `PENDING_EVIDENCE: ${promo.promotion_application_reason}`,
      saved_driver_net_pence: savedDriverNet,
      canonical_driver_net_pence: null,
      driver_net_difference_pence: null,
      saved_commissionable_fare_pence: savedCommissionable,
      canonical_commissionable_fare_pence: promo.canonical_commissionable_fare_pence,
      canonical_commission_pence: null,
    };
  }

  const canonical = calculateTripSettlementFromTripRow(trip as TripSettlementTripRow);
  if (!canonical) {
    return {
      status: "SETTLEMENT_CORRECTION_REQUIRED",
      reason: "PENDING_EVIDENCE: canonical settlement cannot be resolved from saved evidence",
      saved_driver_net_pence: savedDriverNet,
      canonical_driver_net_pence: null,
      driver_net_difference_pence: null,
      saved_commissionable_fare_pence: savedCommissionable,
      canonical_commissionable_fare_pence: promo.canonical_commissionable_fare_pence,
      canonical_commission_pence: null,
    };
  }

  const canonicalDriverNet = canonical.driver_net_pence;
  const canonicalCommissionable = canonical.commissionable_fare_pence;
  const savedDiff = savedDriverNet == null ? null : canonicalDriverNet - savedDriverNet;

  if (
    promo.promotion_application_status === "SETTLEMENT_BASE_DEFECT"
    || (savedCommissionable != null && savedCommissionable !== canonicalCommissionable)
    || (savedDriverNet != null && savedDriverNet !== canonicalDriverNet)
  ) {
    return {
      status: "SETTLEMENT_CORRECTION_REQUIRED",
      reason: promo.promotion_application_status === "SETTLEMENT_BASE_DEFECT"
        ? promo.promotion_application_reason
        : "Saved settlement stamps differ from canonical pre-promotion settlement",
      saved_driver_net_pence: savedDriverNet,
      canonical_driver_net_pence: canonicalDriverNet,
      driver_net_difference_pence: savedDiff,
      saved_commissionable_fare_pence: savedCommissionable,
      canonical_commissionable_fare_pence: canonicalCommissionable,
      canonical_commission_pence: canonical.commission_pence,
    };
  }

  return null;
}

function savedCommissionAfterPromotionPence(trip: Record<string, unknown>): number | null {
  const snap = trip.fare_snapshot_json && typeof trip.fare_snapshot_json === "object"
    ? trip.fare_snapshot_json as Record<string, unknown>
    : {};
  if (snap.commission_after_promotion_pence != null) {
    return safePence(snap.commission_after_promotion_pence);
  }
  const commission = safePence(trip.commission_pence);
  const promo = safePence(trip.offer_discount_pence);
  if (commission == null || promo == null) return null;
  return Math.max(0, commission - promo);
}

function addHoursIso(iso: string, hours: number): string | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms + hours * 3_600_000).toISOString();
}

async function countExact(
  supabase: SupabaseClient,
  table: string,
  column: string,
  value: string,
): Promise<number | null> {
  const { data, error, count } = await supabase
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq(column, value);
  if (error) return null;
  if (typeof count === "number") return count;
  return Array.isArray(data) ? data.length : 0;
}

export const TRIP_WALLET_RECOVERY_SELECT =
  "id, trip_code, status, driver_id, financial_model, driver_net_pence, airport_charge_pence, " +
  "commission_pct, accepted_commission_percent, driver_tier_commission_percent, " +
  "tip_pence, tip_amount_pence, currency_code, currency, provider_order_id, created_at, " +
  "commissionable_fare_pence, commission_pence, final_fare_pence, offer_discount_pence, discount_source, " +
  "locked_base_fare_pence, fare_snapshot_json, customer_modification_charge_pence";

export const DRIVER_WALLET_LEDGER_RECOVERY_SELECT = "amount_pence";

export function tripWalletRecoverySelectColumns(): string[] {
  return TRIP_WALLET_RECOVERY_SELECT.split(/,\s*/).map((c) => c.trim()).filter(Boolean);
}

/**
 * Recover wallet credit for one explicit trip UUID.
 *
 * Credit amount is always saved driver_net_pence + airport_charge_pence.
 * Settlement calculator is used only as a safety gate to block defective stamps.
 *
 * @param dryRun - When true (default), no DB writes are made; result shows what would happen.
 */
export async function recoverCapturedTripWallet(
  supabase: SupabaseClient,
  args: {
    tripId: string;
    allowedTripIds: readonly string[];
    dryRun?: boolean;
    nowMs?: number;
  },
): Promise<CapturedTripWalletRecoveryResult> {
  const tripId = String(args.tripId ?? "").trim();
  const dryRun = args.dryRun !== false; // default to dry-run
  const nowMs = args.nowMs ?? Date.now();

  if (!args.allowedTripIds.includes(tripId)) {
    return { tripId, tripCode: null, dryRun, status: "NOT_IN_ALLOW_LIST" };
  }

  const { data: trip } = await supabase
    .from("trips")
    .select(TRIP_WALLET_RECOVERY_SELECT)
    .eq("id", tripId)
    .maybeSingle();

  const tripCode = trip?.trip_code ? String(trip.trip_code) : null;

  if (!trip) {
    return { tripId, tripCode, dryRun, status: "TRIP_NOT_FOUND" };
  }

  const tripStatus = String(trip.status ?? "").trim().toLowerCase();
  if (tripStatus && tripStatus !== "completed") {
    return { tripId, tripCode, dryRun, status: "TRIP_NOT_COMPLETED", trip_status: tripStatus };
  }

  const financialModel = String(trip.financial_model ?? "").toUpperCase();
  if (financialModel === SERVICE_AREA_FINANCIAL_MODEL.DRIVER_COLLECTED_COMMISSION_WALLET) {
    return { tripId, tripCode, dryRun, status: "FINANCIAL_MODEL_VIOLATION", financial_model: financialModel };
  }
  if (financialModel && financialModel !== "PLATFORM_COLLECTED") {
    return { tripId, tripCode, dryRun, status: "FINANCIAL_MODEL_VIOLATION", financial_model: financialModel };
  }

  const driverId = String(trip.driver_id ?? "").trim();
  if (!driverId) {
    return { tripId, tripCode, dryRun, status: "NO_DRIVER_ID" };
  }

  const correctionRequired = assessHistoricalRecoverySettlementSafety(
    trip as Record<string, unknown>,
  );
  if (correctionRequired) {
    return { tripId, tripCode, dryRun, ...correctionRequired };
  }

  // Recovery MUST use saved stamps only — never the safety-gate canonical amount.
  const expectedCredit = Math.max(
    0,
    Math.round(Number(trip.driver_net_pence) || 0)
      + Math.round(Number(trip.airport_charge_pence) || 0),
  );
  const tipPence = Math.max(
    0,
    Math.round(Number(trip.tip_pence ?? trip.tip_amount_pence) || 0),
  );
  const pct = Number(trip.accepted_commission_percent ?? trip.commission_pct);
  const commissionPct = Number.isFinite(pct) ? pct : undefined;
  if (expectedCredit <= 0) {
    return { tripId, tripCode, dryRun, status: "NO_SAVED_ENTITLEMENT" };
  }

  const { data: existingLedger } = await supabase
    .from("driver_wallet_ledger")
    .select(DRIVER_WALLET_LEDGER_RECOVERY_SELECT)
    .eq("related_trip_id", tripId)
    .eq("type", "TRIP_EARNING_NET");

  const existingRows = Array.isArray(existingLedger) ? existingLedger : [];
  const existingCount = existingRows.length;
  const existingAmount = existingRows.reduce(
    (sum: number, r: { amount_pence: unknown }) => sum + Math.max(0, Math.round(Number(r.amount_pence) || 0)),
    0,
  );
  if (existingCount > 1) {
    return { tripId, tripCode, dryRun, status: "DUPLICATE_WALLET_CREDIT", existing_count: existingCount };
  }
  if (existingCount === 1) {
    if (existingAmount !== expectedCredit) {
      return {
        tripId,
        tripCode,
        dryRun,
        status: "WALLET_AMOUNT_MISMATCH",
        expected_pence: expectedCredit,
        actual_pence: existingAmount,
      };
    }
    return { tripId, tripCode, dryRun, status: "ALREADY_CREDITED", credited_pence: existingAmount };
  }

  const cwCount = await countExact(supabase, "driver_commission_wallet_ledger", "trip_id", tripId);
  if (cwCount == null) {
    return { tripId, tripCode, dryRun, status: "MODEL_ISOLATION_BLOCKED", reason: "commission_wallet_query_failed" };
  }
  if (cwCount > 0) {
    return { tripId, tripCode, dryRun, status: "MODEL_ISOLATION_BLOCKED", reason: "commission_wallet_rows_present" };
  }

  const payoutCount = await countExact(supabase, "payout_items", "trip_id", tripId);
  if (payoutCount == null) {
    return { tripId, tripCode, dryRun, status: "MODEL_ISOLATION_BLOCKED", reason: "payout_item_query_failed" };
  }
  if (payoutCount > 0) {
    return { tripId, tripCode, dryRun, status: "MODEL_ISOLATION_BLOCKED", reason: "payout_items_present" };
  }

  const sessionLoad = await loadWalletRecoveryPaymentSessions(supabase, tripId);
  if (sessionLoad.error) {
    return {
      tripId,
      tripCode,
      dryRun,
      status: "PAYMENT_SESSION_BLOCKED",
      reason: `payment_session_gate_query:${sessionLoad.error.code ?? "error"}:${sessionLoad.error.message}`,
    };
  }

  const rideBooking = sessionLoad.sessions.filter((row) =>
    String(row.purpose ?? "").toUpperCase() === "RIDE_BOOKING"
  );
  if (sessionLoad.sessions.length === 0 || rideBooking.length === 0) {
    return { tripId, tripCode, dryRun, status: "PAYMENT_SESSION_NOT_FOUND" };
  }
  if (rideBooking.length !== 1 || sessionLoad.sessions.length !== 1) {
    return {
      tripId,
      tripCode,
      dryRun,
      status: "PAYMENT_SESSION_BLOCKED",
      reason: `session_count_not_one:${sessionLoad.sessions.length}:ride_booking:${rideBooking.length}`,
    };
  }

  let session: PaymentSessionGateRow = rideBooking[0];
  const orderIds = new Set(
    rideBooking.map((row) => String(row.provider_order_id ?? "").trim()).filter(Boolean),
  );
  const captureIds = new Set(
    rideBooking.map((row) => String(row.provider_capture_id ?? "").trim()).filter(Boolean),
  );
  if (orderIds.size !== 1 || captureIds.size !== 1) {
    return {
      tripId,
      tripCode,
      dryRun,
      status: "PAYMENT_SESSION_BLOCKED",
      reason: `provider_identity_not_unique:orders:${orderIds.size}:captures:${captureIds.size}`,
    };
  }

  if (isPaymentSessionLifecycleMismatch(session)) {
    if (dryRun) {
      return {
        tripId,
        tripCode,
        dryRun,
        status: "PAYMENT_SESSION_BLOCKED",
        reason: `status_not_captured:${String(session.status ?? "")}`,
      };
    }
    const finResult = await finalizePaymentSessionLifecycleMismatch(supabase, session, {
      tripId,
      source: "capturedTripWalletRecovery",
      tripFinancialModel: financialModel,
    });
    if (!finResult.finalized) {
      return {
        tripId,
        tripCode,
        dryRun,
        status: "LIFECYCLE_FINALIZATION_FAILED",
        reason: "reason" in finResult ? finResult.reason : "unknown",
      };
    }
    session = { ...session, status: "captured" };
  }

  if (!paymentSessionAllowsWalletPosting(session)) {
    const precondition = checkPsLifecycleFinalizerPreconditions(session, {
      tripFinancialModel: financialModel,
    });
    const refunded = Math.round(Number(session.refunded_amount_pence) || 0);
    const released = Math.round(Number(session.released_amount_pence) || 0);
    const reason = refunded > 0
      ? "refund_exists"
      : released > 0 || String(session.hold_release_state ?? "").toLowerCase() === "released"
      ? "release_contradiction"
      : (precondition ?? `status_not_captured:${String(session.status ?? "")}`);
    return { tripId, tripCode, dryRun, status: "PAYMENT_SESSION_BLOCKED", reason };
  }

  const capturedAmount = Math.round(Number(session.captured_amount_pence) || 0);
  const commissionAfter = savedCommissionAfterPromotionPence(trip as Record<string, unknown>);
  const identityRhs = expectedCredit + (commissionAfter ?? 0) + tipPence;
  if (commissionAfter == null || capturedAmount !== identityRhs) {
    return {
      tripId,
      tripCode,
      dryRun,
      status: "PAYMENT_SESSION_BLOCKED",
      reason: `capture_identity_mismatch:captured:${capturedAmount}:rhs:${identityRhs}`,
    };
  }

  const capturedAt = session.captured_at ? String(session.captured_at) : null;
  const eligibleAt = capturedAt
    ? addHoursIso(capturedAt, DEFAULT_PAYOUT_CLEARING_DELAY_HOURS)
    : null;
  const eligibleMs = eligibleAt ? Date.parse(eligibleAt) : NaN;
  const eligibilityClassification: "Pending" | "Available" =
    Number.isFinite(eligibleMs) && eligibleMs <= nowMs ? "Available" : "Pending";

  const proposedDescription = commissionPct != null
    ? `Trip earning (net of ${commissionPct}% commission)`
    : "Trip earning (net of commission)";
  const currency = String(trip.currency ?? trip.currency_code ?? "GBP").toUpperCase();

  if (dryRun) {
    return {
      tripId,
      tripCode,
      dryRun: true,
      status: "DRY_RUN_ELIGIBLE",
      expected_credit_pence: expectedCredit,
      session_status: String(session.status ?? "captured"),
      payment_session_id: session.id ? String(session.id) : null,
      provider_capture_id: session.provider_capture_id ? String(session.provider_capture_id) : null,
      provider_order_id: session.provider_order_id ? String(session.provider_order_id) : null,
      driver_id: driverId,
      existing_wallet_count: 0,
      existing_wallet_amount_pence: 0,
      proposed_ledger_type: "TRIP_EARNING_NET",
      proposed_amount_pence: expectedCredit,
      currency,
      proposed_related_trip_id: tripId,
      proposed_description: proposedDescription,
      captured_at: capturedAt,
      eligible_at: eligibleAt,
      eligibility_classification: eligibilityClassification,
      provider_operation_required: false,
      settlement_recalculation_required: false,
    };
  }

  try {
    const ledger = await creditCapturedCardTripLedger(supabase, {
      driverId,
      tripId,
      driverNetPence: expectedCredit,
      tipPence,
      currency,
      paymentId: session.provider_order_id ? String(session.provider_order_id) : null,
      commissionPct,
    });
    if (!ledger.credited && expectedCredit > 0) {
      throw new Error("ledger credit returned credited:false");
    }
    return { tripId, tripCode, dryRun: false, status: "CREDITED", credited_pence: expectedCredit };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[capturedTripWalletRecovery] credit failed", { trip_id: tripId, error: message });
    return { tripId, tripCode, dryRun: false, status: "CREDIT_FAILED", error: message };
  }
}
