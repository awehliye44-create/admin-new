/**
 * Customer shortfall evidence SSOT — single pure helper for Trip History,
 * FR display, and admin-recapture-trip-shortfall.
 *
 * Hard rules:
 * - `final_customer_fare_pence` is tip-exclusive (established trip stamp contract).
 * - `customer_payable_pence` is the tip-inclusive authoritative aggregate — use once.
 * - Never overwrite fare-only fields with aggregates.
 * - Never infer tip fold from numeric comparisons.
 * - Unknown semantics → fail closed (payable/shortfall unavailable, no recapture).
 * - Tip/airport may display as components while already in the aggregate;
 *   displaying them must never add them again.
 */

import {
  computeOutstandingShortfallPence,
  evaluateTripHistoryShortfallRecaptureEligibility,
  isPlatformCollectedEligible,
  isVerifiedSettledCaptureSession,
  sumVerifiedCapturedFromSessions,
  sumVerifiedRefundedFromSessions,
  type TripShortfallRecaptureUiState,
} from "./tripHistoryShortfallRecaptureSSOT.ts";

export const CUSTOMER_PAYABLE_SOURCE = {
  AUTHORITATIVE_CUSTOMER_PAYABLE: "authoritative_customer_payable_pence",
  COMPONENTS_TIP_EXCLUSIVE_FINAL: "components_tip_exclusive_final",
  NO_SHOW_CHARGE: "no_show_charge_pence",
  CANCELLATION_FEE: "cancellation_fee_pence",
  UNAVAILABLE_UNKNOWN_SEMANTICS: "unavailable_unknown_semantics",
} as const;

export type CustomerPayableSource =
  typeof CUSTOMER_PAYABLE_SOURCE[keyof typeof CUSTOMER_PAYABLE_SOURCE];

/** How to interpret final_* stamps. Never guess. */
export const FARE_FIELD_CONTRACT = {
  /** trips.final_customer_fare_pence / final_fare_pence — tip-exclusive. */
  TIP_EXCLUSIVE_FINAL: "tip_exclusive_final",
  /** Explicit tip-inclusive aggregate supplied as customer_payable_pence. */
  AUTHORITATIVE_AGGREGATE: "authoritative_aggregate",
  /** Legacy / stuffed / ambiguous — fail closed. */
  UNKNOWN: "unknown",
} as const;

export type FareFieldContract =
  typeof FARE_FIELD_CONTRACT[keyof typeof FARE_FIELD_CONTRACT];

export type CustomerShortfallSession = {
  id?: string | null;
  purpose?: string | null;
  status?: string | null;
  provider_state?: string | null;
  provider_order_id?: string | null;
  captured_amount_pence?: number | null;
  authorised_amount_pence?: number | null;
  refunded_amount_pence?: number | null;
  customer_id?: string | null;
};

export type CustomerShortfallEvidenceInput = {
  /** Tip-exclusive fare stamp (contractual). */
  final_customer_fare_pence?: number | null;
  final_fare_pence?: number | null;
  locked_base_fare_pence?: number | null;
  tip_pence?: number | null;
  tip_amount_pence?: number | null;
  /** Display component only — never added on top of tip-exclusive final. */
  airport_charge_pence?: number | null;
  no_show_charge_pence?: number | null;
  cancellation_fee_pence?: number | null;
  outstanding_balance_pence?: number | null;
  payment_status?: string | null;
  financial_outcome?: string | null;
  status?: string | null;
  financial_model?: string | null;
  payment_method?: string | null;
  capture_amount_pence?: number | null;
  /**
   * Explicit tip-inclusive aggregate. When present and > 0, used exactly once.
   * Never combine with the component path.
   */
  customer_payable_pence?: number | null;
  customer_payable_source?: CustomerPayableSource | null;
  /**
   * Required for non-authoritative paths. Defaults to tip_exclusive_final when
   * reading raw trip stamps. Set UNKNOWN to fail closed.
   */
  fare_field_contract?: FareFieldContract | null;
  sessions?: CustomerShortfallSession[] | null;
  trip_capture_fallback_pence?: number | null;
  providerSettlementVerified?: boolean | null;
  hasOpenRecoveryAttempt?: boolean;
  adminPermitted?: boolean;
  /** Optional client-declared shortfall — must match server exactly if present. */
  client_expected_shortfall_pence?: number | null;
  passenger_id?: string | null;
};

export type CustomerShortfallEvidence = {
  fare_component_pence: number | null;
  tip_component_pence: number | null;
  airport_component_pence: number | null;
  authoritative_customer_payable_pence: number | null;
  verified_captured_pence: number;
  verified_refunded_pence: number;
  verified_net_captured_pence: number;
  outstanding_shortfall_pence: number | null;
  payable_source: CustomerPayableSource;
  capture_source: string;
  evidence_complete: boolean;
  recapture_eligible: boolean;
  recapture_ui_state: TripShortfallRecaptureUiState | null;
  unavailable_reason: string | null;
  /** True only when every pre-provider gate passes — handler must not fetch recovery. */
  allow_provider_call: boolean;
  reject_code: string | null;
};

function positivePence(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n);
}

function nullablePence(value: unknown): number | null {
  if (value == null) return null;
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return null;
  return n;
}

function looksLikeTerminalFeeTrip(input: CustomerShortfallEvidenceInput): boolean {
  const blob = `${input.payment_status ?? ""} ${input.financial_outcome ?? ""} ${input.status ?? ""}`
    .toLowerCase();
  return blob.includes("no_show")
    || blob.includes("noshow")
    || blob.includes("cancel")
    || blob.includes("arrival_cancellation");
}

/**
 * Resolve tip-inclusive customer payable with explicit ownership.
 * Never mixes authoritative aggregate with component addition.
 */
export function resolveAuthoritativeCustomerPayable(input: CustomerShortfallEvidenceInput): {
  payable_pence: number | null;
  source: CustomerPayableSource;
  unavailable_reason: string | null;
} {
  const explicit = positivePence(input.customer_payable_pence);
  if (explicit > 0) {
    return {
      payable_pence: explicit,
      source: input.customer_payable_source
        ?? CUSTOMER_PAYABLE_SOURCE.AUTHORITATIVE_CUSTOMER_PAYABLE,
      unavailable_reason: null,
    };
  }

  const contract = input.fare_field_contract
    ?? FARE_FIELD_CONTRACT.TIP_EXCLUSIVE_FINAL;

  if (contract === FARE_FIELD_CONTRACT.UNKNOWN) {
    return {
      payable_pence: null,
      source: CUSTOMER_PAYABLE_SOURCE.UNAVAILABLE_UNKNOWN_SEMANTICS,
      unavailable_reason: "Fare field semantics unknown — refuse tip fold inference",
    };
  }

  if (contract === FARE_FIELD_CONTRACT.AUTHORITATIVE_AGGREGATE) {
    // Aggregate path requires customer_payable_pence; without it, fail closed.
    return {
      payable_pence: null,
      source: CUSTOMER_PAYABLE_SOURCE.UNAVAILABLE_UNKNOWN_SEMANTICS,
      unavailable_reason: "Authoritative aggregate contract requires customer_payable_pence",
    };
  }

  // Component path: tip-exclusive final_* + tip once. Airport is display-only
  // (already inside final when folded; never added again here).
  const tip = positivePence(input.tip_pence ?? input.tip_amount_pence);
  const finalCustomer = positivePence(input.final_customer_fare_pence);
  const finalFare = positivePence(input.final_fare_pence);
  // Prefer tip-exclusive discounted customer stamp over gross final_fare.
  // Never Math.max(gross, discounted) — that reintroduces promotions as shortfall.
  const fareOnly = finalCustomer > 0 ? finalCustomer : finalFare;
  const noShow = positivePence(input.no_show_charge_pence);
  const cancelFee = positivePence(input.cancellation_fee_pence);
  const terminalFee = Math.max(noShow, cancelFee);

  if (terminalFee > 0 && (looksLikeTerminalFeeTrip(input) || fareOnly <= 0 || terminalFee < fareOnly)) {
    return {
      payable_pence: terminalFee + tip,
      source: noShow >= cancelFee
        ? CUSTOMER_PAYABLE_SOURCE.NO_SHOW_CHARGE
        : CUSTOMER_PAYABLE_SOURCE.CANCELLATION_FEE,
      unavailable_reason: null,
    };
  }

  if (fareOnly <= 0 && tip <= 0) {
    return {
      payable_pence: null,
      source: CUSTOMER_PAYABLE_SOURCE.UNAVAILABLE_UNKNOWN_SEMANTICS,
      unavailable_reason: "No tip-exclusive fare stamp or tip component available",
    };
  }

  return {
    payable_pence: fareOnly + tip,
    source: CUSTOMER_PAYABLE_SOURCE.COMPONENTS_TIP_EXCLUSIVE_FINAL,
    unavailable_reason: null,
  };
}

function resolveVerifiedCapture(input: CustomerShortfallEvidenceInput): {
  captured: number;
  refunded: number;
  source: string;
} {
  const sessions = input.sessions ?? [];
  const verified = sumVerifiedCapturedFromSessions(sessions);
  const refunded = sumVerifiedRefundedFromSessions(sessions);
  let captured = verified.total_verified_captured_pence;
  let source = captured > 0 ? "payment_sessions_verified" : "none";

  if (captured <= 0) {
    const fallback = positivePence(
      input.trip_capture_fallback_pence ?? input.capture_amount_pence,
    );
    if (fallback > 0) {
      const ps = String(input.payment_status ?? "").toLowerCase();
      if (!ps.includes("cancel") && !ps.includes("fail") && !ps.includes("void") && !ps.includes("pending") && !ps.includes("process")) {
        captured = fallback;
        source = "trip_capture_fallback";
      }
    }
  }

  // Pending / failed sessions must not inflate capture via non-verified amounts.
  for (const s of sessions) {
    const blob = `${s.status ?? ""} ${s.provider_state ?? ""}`.toLowerCase();
    if (
      blob.includes("pending")
      || blob.includes("process")
      || blob.includes("initiat")
      || blob.includes("request")
      || blob.includes("fail")
      || blob.includes("declin")
      || blob.includes("cancel")
      || blob.includes("unknown")
    ) {
      if (!isVerifiedSettledCaptureSession(s) && positivePence(s.captured_amount_pence) > 0) {
        // Explicitly ignore non-verified captures.
        continue;
      }
    }
  }

  return { captured, refunded, source };
}

/**
 * Pure shortfall evidence — shared by UI mapping and admin-recapture.
 */
export function buildCustomerShortfallEvidence(
  input: CustomerShortfallEvidenceInput,
): CustomerShortfallEvidence {
  const fare = nullablePence(input.final_customer_fare_pence)
    ?? nullablePence(input.final_fare_pence);
  const tip = nullablePence(input.tip_pence ?? input.tip_amount_pence);
  const airport = nullablePence(input.airport_charge_pence);

  const payable = resolveAuthoritativeCustomerPayable(input);
  const capture = resolveVerifiedCapture(input);
  const net = Math.max(0, capture.captured - capture.refunded);

  const payableKnown = payable.payable_pence != null
    && payable.source !== CUSTOMER_PAYABLE_SOURCE.UNAVAILABLE_UNKNOWN_SEMANTICS;

  const outstanding = payableKnown
    ? computeOutstandingShortfallPence({
      customerPayablePence: payable.payable_pence,
      verifiedCapturedTotalPence: capture.captured,
      netRefundedTotalPence: capture.refunded,
    })
    : null;

  let unavailable_reason = payable.unavailable_reason;
  if (!payableKnown) {
    unavailable_reason = unavailable_reason ?? "Customer payable unavailable";
  }

  const platformOk = isPlatformCollectedEligible(input.financial_model);
  const providerVerified = input.providerSettlementVerified === true
    || (capture.captured > 0
      && payableKnown
      && outstanding === 0
      && capture.source.startsWith("payment_sessions"));

  const gate = payableKnown
    ? evaluateTripHistoryShortfallRecaptureEligibility({
      tripStatus: input.status,
      financialModel: input.financial_model,
      paymentMethod: input.payment_method,
      customerPayablePence: payable.payable_pence,
      verifiedCapturedTotalPence: capture.captured,
      netRefundedTotalPence: capture.refunded,
      providerSettlementVerified: providerVerified,
      hasOpenRecoveryAttempt: input.hasOpenRecoveryAttempt,
      adminPermitted: input.adminPermitted !== false,
    })
    : {
      eligible: false,
      ui_state: null as TripShortfallRecaptureUiState | null,
      outstanding_shortfall_pence: null,
      reject_reason: "payable_unavailable",
    };

  let reject_code: string | null = gate.reject_reason;
  let allow_provider_call = false;

  if (!payableKnown) {
    reject_code = "PAYABLE_UNAVAILABLE";
  } else if (!platformOk) {
    reject_code = "DRIVER_COLLECTED_NOT_ALLOWED";
  } else if ((outstanding ?? 0) <= 0) {
    reject_code = "NO_SHORTFALL_DUE";
  }

  if (input.client_expected_shortfall_pence != null && reject_code !== "PAYABLE_UNAVAILABLE") {
    const clientAmt = Math.round(Number(input.client_expected_shortfall_pence));
    if (!Number.isFinite(clientAmt) || clientAmt !== (outstanding ?? -1)) {
      reject_code = "STALE_CLIENT_AMOUNT";
    }
  }

  if (input.passenger_id) {
    for (const s of input.sessions ?? []) {
      if (s.customer_id != null && s.customer_id !== input.passenger_id) {
        reject_code = "SESSION_CUSTOMER_MISMATCH";
        break;
      }
    }
  }

  if (
    reject_code == null
    && gate.eligible
    && (outstanding ?? 0) > 0
    && payableKnown
    && platformOk
  ) {
    allow_provider_call = true;
  }

  // Zero shortfall is not an error surface — hide recapture.
  if (reject_code === "NO_SHORTFALL_DUE") {
    allow_provider_call = false;
  }

  const recapture_eligible = allow_provider_call;

  return {
    fare_component_pence: fare,
    tip_component_pence: tip,
    airport_component_pence: airport,
    authoritative_customer_payable_pence: payable.payable_pence,
    verified_captured_pence: capture.captured,
    verified_refunded_pence: capture.refunded,
    verified_net_captured_pence: net,
    outstanding_shortfall_pence: outstanding,
    payable_source: payable.source,
    capture_source: capture.source,
    evidence_complete: payableKnown,
    recapture_eligible,
    recapture_ui_state: gate.ui_state,
    unavailable_reason: recapture_eligible
      ? null
      : (reject_code === "NO_SHORTFALL_DUE" ? null : (unavailable_reason ?? reject_code)),
    allow_provider_call,
    reject_code: allow_provider_call ? null : reject_code,
  };
}

/**
 * Provider-call boundary — returns whether create-payment-recovery may be invoked.
 * Used by admin-recapture and lock tests (provider call count must stay 0 on reject).
 */
export function evaluateRecaptureProviderCallBoundary(
  evidence: CustomerShortfallEvidence,
): { allow_provider_call: boolean; reject_code: string | null } {
  return {
    allow_provider_call: evidence.allow_provider_call === true,
    reject_code: evidence.reject_code,
  };
}
