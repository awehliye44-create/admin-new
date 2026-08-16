/**
 * Customer invoice payment SSOT.
 *
 * A completed trip is NOT proof of payment. This module resolves the authoritative
 * amount the customer actually paid for ONE exact trip from provider/reconciliation
 * evidence, and decides whether a normal customer invoice email may be sent.
 *
 * Pure functions only — callers fetch the evidence rows and pass them in.
 */

export type TripInvoicePaymentClassification =
  | "FULLY_PAID"
  | "PARTIALLY_PAID"
  | "UNPAID"
  | "PAYMENT_FAILED"
  | "PAYMENT_PENDING"
  | "REFUNDED"
  | "PARTIALLY_REFUNDED"
  | "RECONCILIATION_REQUIRED";

export type TripPaymentModel = "PLATFORM_COLLECTED" | "DRIVER_COLLECTED_COMMISSION_WALLET";

/** Rounding tolerance in pence when comparing paid vs final fare. */
export const PAID_TOLERANCE_PENCE = 2;

const CARD_METHODS = new Set(["card", "apple_pay", "google_pay", "wallet", "digital", "revolut"]);

const CAPTURED_SESSION_STATUSES = new Set([
  "captured",
  "completed",
  "completed_pending_capture",
  "capture_confirmed",
  "recovery_completed",
  "partial_capture_only",
]);

const FAILED_PAYMENT_TOKENS = [
  "capture_failed",
  "failed",
  "declined",
  "recovery_required",
  "payment_recovery_required",
  "recovery_declined",
  "recovery_expired",
  "cancelled",
  "canceled",
  "orphan",
  "shortfall",
];

export interface TripPaymentEvidenceTrip {
  id: string;
  status?: string | null;
  payment_method?: string | null;
  payment_status?: string | null;
  payment_collection_model?: string | null;
  financial_model?: string | null;
  final_customer_fare_pence?: number | null;
  final_fare_pence?: number | null;
  gross_fare_pence?: number | null;
  cash_collected_at?: string | null;
  driver_payment_confirmed_at?: string | null;
}

export interface PaymentSessionEvidence {
  id?: string | null;
  trip_id?: string | null;
  status?: string | null;
  provider_state?: string | null;
  captured_amount_pence?: number | null;
  authorised_amount_pence?: number | null;
  refunded_amount_pence?: number | null;
  provider_payment_id?: string | null;
  provider_capture_id?: string | null;
  provider_order_id?: string | null;
}

export interface PaymentRowEvidence {
  id?: string | null;
  trip_id?: string | null;
  status?: string | null;
  provider_status?: string | null;
  amount_pence?: number | null;
  captured_amount_pence?: number | null;
  refunded_amount_pence?: number | null;
  provider_payment_id?: string | null;
  provider_charge_id?: string | null;
}

export interface TripInvoicePaymentState {
  tripId: string;
  paymentModel: TripPaymentModel;
  paymentMethod: string;
  finalFarePence: number;
  authoritativePaidPence: number;
  refundedPence: number;
  outstandingPence: number;
  paymentClassification: TripInvoicePaymentClassification;
  evidenceSource: string;
  providerTransactionIds: string[];
  invoiceEligible: boolean;
  blockReason: string | null;
  resolvedAt: string;
}

export function resolveTripPaymentModel(trip: TripPaymentEvidenceTrip): TripPaymentModel {
  const raw = String(trip.payment_collection_model ?? trip.financial_model ?? "").toUpperCase();
  if (raw.includes("DRIVER_COLLECTED")) return "DRIVER_COLLECTED_COMMISSION_WALLET";
  return "PLATFORM_COLLECTED";
}

export function resolveFinalFarePence(trip: TripPaymentEvidenceTrip): number {
  const candidates = [
    trip.final_customer_fare_pence,
    trip.final_fare_pence,
    trip.gross_fare_pence,
  ];
  for (const value of candidates) {
    if (value != null && Number.isFinite(Number(value)) && Number(value) > 0) {
      return Math.round(Number(value));
    }
  }
  return 0;
}

function isCardLike(method: string): boolean {
  return CARD_METHODS.has(method) || method === "";
}

function looksFailed(...values: Array<string | null | undefined>): boolean {
  return values.some((value) => {
    const v = String(value ?? "").toLowerCase();
    if (!v) return false;
    return FAILED_PAYMENT_TOKENS.some((token) => v.includes(token));
  });
}

function positive(value: number | null | undefined): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

interface CaptureFact {
  key: string;
  capturedPence: number;
  refundedPence: number;
  source: string;
  /** True when the fact carries a durable provider transaction identity. */
  identified: boolean;
}

/** Durable provider identity for a session row, or null when the row has none. */
function sessionProviderIdentity(session: PaymentSessionEvidence): string | null {
  const id = session.provider_capture_id || session.provider_payment_id || session.provider_order_id;
  return id ? String(id) : null;
}

/** Durable provider identity for a payments row, or null when the row has none. */
function paymentProviderIdentity(payment: PaymentRowEvidence): string | null {
  const id = payment.provider_payment_id || payment.provider_charge_id;
  return id ? String(id) : null;
}

/**
 * Capture evidence collection.
 *
 * `payment_sessions` is the PRIMARY authoritative capture ledger for a trip.
 * A `payments` row only adds money when it proves an INDEPENDENT provider transaction.
 * A `payments` row with no durable provider identity, on a trip that already has session
 * capture evidence, is a MIRROR of that capture and must never be summed.
 */
function collectCaptureFacts(
  tripId: string,
  sessions: PaymentSessionEvidence[],
  payments: PaymentRowEvidence[],
): CaptureFact[] {
  const byKey = new Map<string, CaptureFact>();
  const sessionFacts: CaptureFact[] = [];

  const mergeInto = (fact: CaptureFact, capturedPence: number, refundedPence: number) => {
    // Same provider transaction seen twice — keep the larger confirmed evidence, never sum.
    fact.capturedPence = Math.max(fact.capturedPence, capturedPence);
    fact.refundedPence = Math.max(fact.refundedPence, refundedPence);
  };

  for (const session of sessions) {
    if (session.trip_id && session.trip_id !== tripId) continue;
    const captured = positive(session.captured_amount_pence);
    const status = String(session.status ?? "").toLowerCase();
    const providerState = String(session.provider_state ?? "").toLowerCase();
    const statusCaptured = CAPTURED_SESSION_STATUSES.has(status) || providerState === "captured" ||
      providerState === "completed";
    if (captured <= 0) continue;
    if (!statusCaptured && looksFailed(status, providerState)) continue;
    const identity = sessionProviderIdentity(session);
    const key = identity ?? `session:${session.id ?? sessionFacts.length}`;
    const existing = byKey.get(key);
    if (existing) {
      mergeInto(existing, captured, positive(session.refunded_amount_pence));
      continue;
    }
    const fact: CaptureFact = {
      key,
      capturedPence: captured,
      refundedPence: positive(session.refunded_amount_pence),
      source: "payment_sessions",
      identified: identity != null,
    };
    byKey.set(key, fact);
    sessionFacts.push(fact);
  }

  for (const payment of payments) {
    if (payment.trip_id && payment.trip_id !== tripId) continue;
    const status = String(payment.status ?? "").toLowerCase();
    const providerStatus = String(payment.provider_status ?? "").toLowerCase();
    let captured = positive(payment.captured_amount_pence);
    if (captured <= 0 && (status === "captured" || status === "succeeded" || status === "paid")) {
      captured = positive(payment.amount_pence);
    }
    if (captured <= 0) continue;
    if (looksFailed(status, providerStatus) && positive(payment.captured_amount_pence) <= 0) continue;
    const refunded = positive(payment.refunded_amount_pence);
    const identity = paymentProviderIdentity(payment);

    if (identity) {
      const existing = byKey.get(identity);
      if (existing) {
        mergeInto(existing, captured, refunded);
      } else {
        // Independent provider transaction — a genuinely separate collection (recovery, split, extra capture).
        byKey.set(identity, {
          key: identity,
          capturedPence: captured,
          refundedPence: refunded,
          source: "payments",
          identified: true,
        });
      }
      continue;
    }

    // No durable provider identity. If the trip already has session capture evidence,
    // this row is a mirror of it — merge, never add a second capture.
    if (sessionFacts.length > 0) {
      const exact = sessionFacts.find((f) => f.capturedPence === captured);
      const target = exact ??
        sessionFacts.reduce((best, f) => (f.capturedPence > best.capturedPence ? f : best), sessionFacts[0]);
      mergeInto(target, captured, refunded);
      continue;
    }

    // No session evidence at all — the payments row is the only capture record for this trip.
    const key = `payment:${payment.id ?? byKey.size}`;
    const existing = byKey.get(key);
    if (existing) {
      mergeInto(existing, captured, refunded);
      continue;
    }
    byKey.set(key, {
      key,
      capturedPence: captured,
      refundedPence: refunded,
      source: "payments",
      identified: false,
    });
  }

  return [...byKey.values()];
}


export function resolveTripInvoicePaymentState(args: {
  trip: TripPaymentEvidenceTrip;
  paymentSessions?: PaymentSessionEvidence[];
  payments?: PaymentRowEvidence[];
  now?: string;
}): TripInvoicePaymentState {
  const { trip } = args;
  const sessions = args.paymentSessions ?? [];
  const payments = args.payments ?? [];
  const resolvedAt = args.now ?? new Date().toISOString();
  const paymentModel = resolveTripPaymentModel(trip);
  const paymentMethod = String(trip.payment_method ?? "").toLowerCase();
  const finalFarePence = resolveFinalFarePence(trip);
  const tripPaymentStatus = String(trip.payment_status ?? "").toLowerCase();

  const base = {
    tripId: trip.id,
    paymentModel,
    paymentMethod: paymentMethod || "unknown",
    finalFarePence,
    refundedPence: 0,
    resolvedAt,
  };

  // ── Driver-collected / cash models: never require a provider capture ──
  const isCash = paymentMethod === "cash" || paymentMethod === "driver_collected";
  if (paymentModel === "DRIVER_COLLECTED_COMMISSION_WALLET" || isCash) {
    const collected = Boolean(trip.cash_collected_at || trip.driver_payment_confirmed_at);
    if (!collected) {
      // Fail closed — never invent a collection.
      return {
        ...base,
        authoritativePaidPence: 0,
        outstandingPence: finalFarePence,
        paymentClassification: "PAYMENT_PENDING",
        evidenceSource: "driver_collected_state",
        providerTransactionIds: [],
        invoiceEligible: false,
        blockReason: "No authoritative driver-collected payment evidence",
      };
    }
    return {
      ...base,
      authoritativePaidPence: finalFarePence,
      outstandingPence: 0,
      paymentClassification: "FULLY_PAID",
      evidenceSource: "driver_collected_state",
      providerTransactionIds: [],
      invoiceEligible: finalFarePence > 0,
      blockReason: finalFarePence > 0 ? null : "Final fare not resolved",
    };
  }

  // ── Platform collected (card / wallet) ──
  const facts = collectCaptureFacts(trip.id, sessions, payments);
  const grossCaptured = facts.reduce((sum, f) => sum + f.capturedPence, 0);
  const refunded = facts.reduce((sum, f) => sum + f.refundedPence, 0);
  const netPaid = Math.max(grossCaptured - refunded, 0);
  const outstanding = Math.max(finalFarePence - netPaid, 0);
  const providerTransactionIds = facts.map((f) => f.key).filter((k) => !k.startsWith("session:") && !k.startsWith("payment:"));
  const evidenceSource = facts.length === 0
    ? "no_capture_evidence"
    : [...new Set(facts.map((f) => f.source))].join("+");

  if (finalFarePence <= 0) {
    return {
      ...base,
      authoritativePaidPence: netPaid,
      refundedPence: refunded,
      outstandingPence: 0,
      paymentClassification: "RECONCILIATION_REQUIRED",
      evidenceSource,
      providerTransactionIds,
      invoiceEligible: false,
      blockReason: "Final fare could not be resolved for this trip",
    };
  }

  if (grossCaptured > 0 && refunded >= grossCaptured) {
    return {
      ...base,
      authoritativePaidPence: 0,
      refundedPence: refunded,
      outstandingPence: finalFarePence,
      paymentClassification: "REFUNDED",
      evidenceSource,
      providerTransactionIds,
      invoiceEligible: false,
      blockReason: "Payment fully refunded",
    };
  }

  if (netPaid <= 0) {
    const failed = looksFailed(tripPaymentStatus)
      || sessions.some((s) => looksFailed(s.status, s.provider_state))
      || payments.some((p) => looksFailed(p.status, p.provider_status));
    return {
      ...base,
      authoritativePaidPence: 0,
      refundedPence: refunded,
      outstandingPence: finalFarePence,
      paymentClassification: failed ? "PAYMENT_FAILED" : "PAYMENT_PENDING",
      evidenceSource,
      providerTransactionIds,
      invoiceEligible: false,
      blockReason: failed
        ? "Capture failed — no money collected"
        : "Awaiting provider capture confirmation",
    };
  }

  // ── Safety invariant: unexplained overpayment must never render as a clean "PAID" invoice ──
  if (netPaid > finalFarePence + PAID_TOLERANCE_PENCE) {
    return {
      ...base,
      authoritativePaidPence: netPaid,
      refundedPence: refunded,
      outstandingPence: 0,
      paymentClassification: "RECONCILIATION_REQUIRED",
      evidenceSource,
      providerTransactionIds,
      invoiceEligible: false,
      blockReason:
        `Collected ${netPaid}p exceeds final fare ${finalFarePence}p — reconciliation required before invoice delivery`,
    };
  }

  if (netPaid + PAID_TOLERANCE_PENCE >= finalFarePence) {
    // A refund that reconciles collection back to the final fare is a settled, fully paid trip.
    return {
      ...base,
      authoritativePaidPence: netPaid,
      refundedPence: refunded,
      outstandingPence: 0,
      paymentClassification: "FULLY_PAID",
      evidenceSource,
      providerTransactionIds,
      invoiceEligible: true,
      blockReason: null,
    };
  }


  return {
    ...base,
    authoritativePaidPence: netPaid,
    refundedPence: refunded,
    outstandingPence: outstanding,
    paymentClassification: refunded > 0 ? "PARTIALLY_REFUNDED" : "PARTIALLY_PAID",
    evidenceSource,
    providerTransactionIds,
    invoiceEligible: refunded === 0,
    blockReason: refunded > 0 ? "Refund present — reconciliation policy review" : null,
  };
}

/** Only these classifications may produce a normal customer invoice email. */
export function isInvoiceEmailAllowed(state: TripInvoicePaymentState): boolean {
  if (!state.invoiceEligible) return false;
  return state.paymentClassification === "FULLY_PAID" || state.paymentClassification === "PARTIALLY_PAID";
}

export function paymentClassificationLabel(classification: TripInvoicePaymentClassification): string {
  switch (classification) {
    case "FULLY_PAID":
      return "Paid";
    case "PARTIALLY_PAID":
      return "Partially paid";
    case "PAYMENT_FAILED":
      return "Payment failed";
    case "UNPAID":
      return "Unpaid";
    case "PAYMENT_PENDING":
      return "Payment pending";
    case "REFUNDED":
      return "Refunded";
    case "PARTIALLY_REFUNDED":
      return "Partially refunded";
    case "RECONCILIATION_REQUIRED":
      return "Reconciliation required";
  }
}
