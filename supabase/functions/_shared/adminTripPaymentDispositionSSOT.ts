/**
 * Admin operational trip pages — read-only Payment Sessions disposition.
 *
 * Trip History + Missed & Cancelled may DISPLAY disposition only.
 * Never mutates payment lifecycle, never reads Driver Wallet / Payout Ledger for customer fare.
 */

import {
  adminNoShowPaymentLabel,
  isAdminNoShowTrip,
  tripHistoryNoShowDisplayLabel,
  type AdminTripClassificationRow,
} from "./adminTripNoShowClassification.ts";

export type AdminPaymentSessionDispositionInput = {
  id?: string | null;
  status?: string | null;
  captured_amount_pence?: number | null;
  released_amount_pence?: number | null;
  refunded_amount_pence?: number | null;
  provider_state?: string | null;
  release_evidence_status?: string | null;
  provider_processing_fee_pence?: number | null;
  fee_status?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type AdminTripPaymentDispositionTrip = AdminTripClassificationRow & {
  financial_model?: string | null;
  cancellation_fee_pence?: number | null;
  payment_status?: string | null;
  payment_disposition?: AdminTripPaymentDispositionRead | null;
};

export type AdminTripPaymentDispositionRead = {
  payment_session_id: string | null;
  captured_amount_pence: number | null;
  released_amount_pence: number | null;
  refunded_amount_pence: number | null;
  provider_processing_fee_pence: number | null;
  fee_status: string | null;
  provider_state: string | null;
  payment_status: string | null;
  payment_label: string;
  amount_label: string | null;
  amount_pence: number | null;
  financial_model: string | null;
  terminal_disposition_reason: string | null;
  is_no_show_outcome: boolean;
};

export const MISSED_CANCELLED_PAYMENT_LABELS = {
  RELEASED: "Released",
  NO_CHARGE: "No charge",
  CANCELLATION_FEE_CHARGED: "Cancellation fee charged",
  REFUNDED: "Refunded",
  PAYMENT_FAILED: "Payment failed",
  PENDING_RELEASE: "Pending release",
  RELEASE_FAILED: "Release failed",
} as const;

export const TRIP_HISTORY_PAYMENT_LABELS = {
  CAPTURED: "Captured",
  PARTIALLY_REFUNDED: "Partially refunded",
  REFUNDED: "Refunded",
  AUTHORISED: "Authorised",
  PENDING_CAPTURE: "Pending capture",
  FAILED: "Payment failed",
  CANCELLED: "Cancelled",
} as const;

function nullablePence(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

function positivePence(value: unknown): number {
  const n = nullablePence(value);
  return n != null && n > 0 ? n : 0;
}

function readSessionProviderFeeFields(
  session: AdminPaymentSessionDispositionInput | null | undefined,
): { provider_processing_fee_pence: number | null; fee_status: string | null } {
  const fee = nullablePence(session?.provider_processing_fee_pence);
  const feeStatus = session?.fee_status != null ? String(session.fee_status) : null;
  return {
    provider_processing_fee_pence: fee,
    fee_status: feeStatus,
  };
}

function blob(...parts: Array<string | null | undefined>): string {
  return parts.map((p) => String(p ?? "").trim().toLowerCase()).join(" ");
}

export function readTerminalDispositionReason(
  session: AdminPaymentSessionDispositionInput | null | undefined,
): string | null {
  const meta = session?.metadata;
  if (!meta || typeof meta !== "object") return null;
  const reason = String(
    (meta as Record<string, unknown>).terminal_disposition_reason ?? "",
  ).trim();
  return reason || null;
}

export function isNoShowTerminalDispositionReason(reason: string | null | undefined): boolean {
  const normalized = String(reason ?? "").trim().toUpperCase();
  return normalized === "CUSTOMER_NO_SHOW" || normalized === "NO_SHOW";
}

export function isNoShowFromPaymentDisposition(
  disposition: Pick<AdminTripPaymentDispositionRead, "is_no_show_outcome" | "terminal_disposition_reason"> | null | undefined,
): boolean {
  if (!disposition) return false;
  if (disposition.is_no_show_outcome) return true;
  return isNoShowTerminalDispositionReason(disposition.terminal_disposition_reason);
}

/** Prefer the session with verified capture, else release, else first row. */
export function pickPrimaryPaymentSession(
  sessions: AdminPaymentSessionDispositionInput[] | null | undefined,
): AdminPaymentSessionDispositionInput | null {
  const rows = [...(sessions ?? [])];
  if (rows.length === 0) return null;
  const scored = rows.map((row, index) => {
    const captured = positivePence(row.captured_amount_pence);
    const released = positivePence(row.released_amount_pence);
    const score = captured > 0 ? 3 : released > 0 ? 2 : 1;
    return { row, index, score };
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored[0]?.row ?? null;
}

function isReleaseFailed(session: AdminPaymentSessionDispositionInput | null): boolean {
  if (!session) return false;
  const state = blob(session.provider_state, session.status, session.release_evidence_status);
  return state.includes("release_fail")
    || state.includes("release_failed")
    || state.includes("void_fail");
}

function isPendingRelease(session: AdminPaymentSessionDispositionInput | null): boolean {
  if (!session) return false;
  const meta = session.metadata;
  if (meta && typeof meta === "object" && (meta as Record<string, unknown>).terminal_disposition_pending === true) {
    return true;
  }
  const state = blob(session.provider_state, session.status);
  return state.includes("releas") && (state.includes("pending") || state.includes("processing"));
}

function isPaymentFailed(session: AdminPaymentSessionDispositionInput | null, tripStatusBlob: string): boolean {
  const state = blob(session?.provider_state, session?.status, tripStatusBlob);
  return state.includes("fail")
    || state.includes("declin")
    || state.includes("error")
    || state.includes("voided");
}

export function resolveMissedCancelledPaymentDisposition(args: {
  trip: AdminTripPaymentDispositionTrip;
  session?: AdminPaymentSessionDispositionInput | null;
}): AdminTripPaymentDispositionRead {
  const session = args.session ?? null;
  const trip = args.trip;
  const captured = nullablePence(session?.captured_amount_pence);
  const released = nullablePence(session?.released_amount_pence);
  const refunded = nullablePence(session?.refunded_amount_pence);
  const providerState = session?.provider_state != null ? String(session.provider_state) : null;
  const paymentStatus = session?.status != null ? String(session.status) : String(trip.payment_status ?? "");
  const terminalReason = readTerminalDispositionReason(session);
  const financialModel = trip.financial_model != null ? String(trip.financial_model) : null;
  const tripBlob = blob(trip.status, trip.financial_outcome, trip.payment_status);
  const providerFeeFields = readSessionProviderFeeFields(session);

  const base: AdminTripPaymentDispositionRead = {
    payment_session_id: session?.id != null ? String(session.id) : null,
    captured_amount_pence: captured,
    released_amount_pence: released,
    refunded_amount_pence: refunded,
    ...providerFeeFields,
    provider_state: providerState,
    payment_status: paymentStatus || null,
    payment_label: MISSED_CANCELLED_PAYMENT_LABELS.NO_CHARGE,
    amount_label: null,
    amount_pence: null,
    financial_model: financialModel,
    terminal_disposition_reason: terminalReason,
    is_no_show_outcome: isNoShowTerminalDispositionReason(terminalReason)
      || isAdminNoShowTrip(trip),
  };

  if (base.is_no_show_outcome) {
    return base;
  }

  if (isReleaseFailed(session)) {
    return {
      ...base,
      payment_label: MISSED_CANCELLED_PAYMENT_LABELS.RELEASE_FAILED,
    };
  }

  if (isPendingRelease(session)) {
    return {
      ...base,
      payment_label: MISSED_CANCELLED_PAYMENT_LABELS.PENDING_RELEASE,
    };
  }

  if (isPaymentFailed(session, tripBlob)) {
    return {
      ...base,
      payment_label: MISSED_CANCELLED_PAYMENT_LABELS.PAYMENT_FAILED,
    };
  }

  if (refunded != null && refunded > 0) {
    const cap = captured ?? 0;
    return {
      ...base,
      payment_label: MISSED_CANCELLED_PAYMENT_LABELS.REFUNDED,
      amount_pence: refunded,
      amount_label: cap > 0 && refunded < cap ? "partial refund" : null,
    };
  }

  if (captured != null && captured > 0) {
    return {
      ...base,
      payment_label: MISSED_CANCELLED_PAYMENT_LABELS.CANCELLATION_FEE_CHARGED,
      amount_pence: captured,
    };
  }

  if (released != null && released > 0) {
    return {
      ...base,
      payment_label: MISSED_CANCELLED_PAYMENT_LABELS.RELEASED,
      amount_pence: released,
    };
  }

  return base;
}

export function resolveTripHistoryPaymentDisposition(args: {
  trip: AdminTripPaymentDispositionTrip;
  session?: AdminPaymentSessionDispositionInput | null;
}): AdminTripPaymentDispositionRead {
  const session = args.session ?? null;
  const trip = args.trip;
  const captured = nullablePence(session?.captured_amount_pence);
  const released = nullablePence(session?.released_amount_pence);
  const refunded = nullablePence(session?.refunded_amount_pence);
  const providerState = session?.provider_state != null ? String(session.provider_state) : null;
  const paymentStatus = session?.status != null ? String(session.status) : String(trip.payment_status ?? "");
  const terminalReason = readTerminalDispositionReason(session);
  const financialModel = trip.financial_model != null ? String(trip.financial_model) : null;
  const isNoShow = isAdminNoShowTrip(trip) || isNoShowTerminalDispositionReason(terminalReason);
  const providerFeeFields = readSessionProviderFeeFields(session);

  const base: AdminTripPaymentDispositionRead = {
    payment_session_id: session?.id != null ? String(session.id) : null,
    captured_amount_pence: captured,
    released_amount_pence: released,
    refunded_amount_pence: refunded,
    ...providerFeeFields,
    provider_state: providerState,
    payment_status: paymentStatus || null,
    payment_label: "—",
    amount_label: null,
    amount_pence: null,
    financial_model: financialModel,
    terminal_disposition_reason: terminalReason,
    is_no_show_outcome: isNoShow,
  };

  if (isNoShow) {
    const noShowLabel = adminNoShowPaymentLabel(trip, captured);
    return {
      ...base,
      payment_label: noShowLabel ?? "No-show - no charge",
      amount_pence: captured != null && captured > 0 ? captured : positivePence(trip.no_show_charge_pence) || null,
    };
  }

  const outcome = String(trip.financial_outcome ?? "").trim().toUpperCase();
  if (outcome === "LATE_PASSENGER_CANCELLATION" && captured != null && captured > 0) {
    return {
      ...base,
      payment_label: MISSED_CANCELLED_PAYMENT_LABELS.CANCELLATION_FEE_CHARGED,
      amount_pence: captured,
    };
  }

  if (refunded != null && refunded > 0) {
    const cap = captured ?? 0;
    return {
      ...base,
      payment_label: cap > 0 && refunded < cap
        ? TRIP_HISTORY_PAYMENT_LABELS.PARTIALLY_REFUNDED
        : TRIP_HISTORY_PAYMENT_LABELS.REFUNDED,
      amount_pence: captured != null && captured > 0 ? captured : null,
    };
  }

  if (captured != null && captured > 0) {
    return {
      ...base,
      payment_label: TRIP_HISTORY_PAYMENT_LABELS.CAPTURED,
      amount_pence: captured,
    };
  }

  if (released != null && released > 0) {
    return {
      ...base,
      payment_label: MISSED_CANCELLED_PAYMENT_LABELS.RELEASED,
      amount_pence: released,
    };
  }

  const statusBlob = blob(paymentStatus, trip.payment_status, providerState);
  if (statusBlob.includes("author")) {
    return { ...base, payment_label: TRIP_HISTORY_PAYMENT_LABELS.AUTHORISED };
  }
  if (statusBlob.includes("pending")) {
    return { ...base, payment_label: TRIP_HISTORY_PAYMENT_LABELS.PENDING_CAPTURE };
  }
  if (statusBlob.includes("fail") || statusBlob.includes("declin")) {
    return { ...base, payment_label: TRIP_HISTORY_PAYMENT_LABELS.FAILED };
  }
  if (statusBlob.includes("cancel")) {
    return { ...base, payment_label: TRIP_HISTORY_PAYMENT_LABELS.CANCELLED };
  }

  return {
    ...base,
    payment_label: paymentStatus || trip.payment_status || "—",
  };
}

export function buildAdminTripPaymentDispositionRead(args: {
  trip: AdminTripPaymentDispositionTrip;
  sessions?: AdminPaymentSessionDispositionInput[] | null;
  surface: "trip_history" | "missed_cancelled";
}): AdminTripPaymentDispositionRead {
  const session = pickPrimaryPaymentSession(args.sessions);
  if (args.surface === "missed_cancelled") {
    return resolveMissedCancelledPaymentDisposition({ trip: args.trip, session });
  }
  return resolveTripHistoryPaymentDisposition({ trip: args.trip, session });
}

export function tripHistoryStatusLabel(trip: AdminTripPaymentDispositionTrip): string {
  const noShow = tripHistoryNoShowDisplayLabel(trip);
  if (noShow) return noShow;
  if (trip.status === "cancelled") return "Cancelled";
  if (trip.financial_outcome === "LATE_PASSENGER_CANCELLATION") return "Late cancellation";
  return "Completed";
}

export const ADMIN_PAYMENT_SESSION_DISPOSITION_SELECT =
  "id, trip_id, status, captured_amount_pence, released_amount_pence, refunded_amount_pence, provider_state, release_evidence_status, provider_processing_fee_pence, fee_status, metadata";
