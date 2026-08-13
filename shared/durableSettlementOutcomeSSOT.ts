/**
 * P0 #1 — durable settlement columns after finalize-trip-and-capture.
 * Completed PLATFORM_COLLECTED card trips must not remain authorized+draft
 * with empty payment_hold_status.
 */

export type DurableSettlementColumns = {
  payment_status: string;
  payment_hold_status: string;
};

export function durableSettlementColumns(
  status: string,
  success: boolean,
): DurableSettlementColumns {
  const s = String(status ?? "").toLowerCase();
  if (
    success &&
    (s === "captured" || s === "completed" || s === "already_captured" ||
      (s.includes("captured") && !s.includes("shortfall") && !s.includes("partial")))
  ) {
    return { payment_status: "captured", payment_hold_status: "captured" };
  }
  if (
    s.includes("shortfall") ||
    s.includes("recovery") ||
    s === "partial_capture_only" ||
    s === "payment_recovery_required"
  ) {
    return {
      payment_status: "payment_shortfall",
      payment_hold_status: s || "payment_shortfall",
    };
  }
  if (s.includes("additional_authorisation") || s.includes("incremental")) {
    return {
      payment_status: "authorized",
      payment_hold_status: s.includes("fail")
        ? "incremental_authorisation_failed"
        : "incremental_authorisation_pending",
    };
  }
  if (
    s === "provider_unsupported" ||
    s === "provider_authorisation_missing" ||
    s.includes("no revolut") ||
    s.includes("missing")
  ) {
    return {
      payment_status: "capture_failed",
      payment_hold_status: "provider_authorisation_missing",
    };
  }
  if (s === "processing" || s === "capture_busy" || s === "capture_pending") {
    return { payment_status: "authorized", payment_hold_status: "capture_pending" };
  }
  return {
    payment_status: success ? "captured" : "capture_failed",
    payment_hold_status: s || (success ? "captured" : "capture_failed"),
  };
}

const UNSETTLED_PAYMENT_STATUSES = new Set([
  "",
  "authorized",
  "authorised",
  "preauth_authorized",
  "preauth_authorised",
]);

const TERMINAL_SETTLEMENT_STATUSES = new Set([
  "captured",
  "payment_shortfall",
  "capture_failed",
]);

/**
 * True when a completed trip still lacks a durable settlement outcome.
 */
export function needsDurableSettlementPersist(args: {
  paymentStatus?: string | null;
  paymentHoldStatus?: string | null;
  paymentState?: string | null;
  finalizeSuccess: boolean;
  finalizeStatus: string;
}): boolean {
  const status = String(args.paymentStatus ?? "").toLowerCase();
  const hold = String(args.paymentHoldStatus ?? "").toLowerCase();
  const cols = durableSettlementColumns(args.finalizeStatus, args.finalizeSuccess);

  if (TERMINAL_SETTLEMENT_STATUSES.has(status) && hold && hold !== "draft") {
    if (cols.payment_status === status) return false;
    // Upgrade authorized → shortfall/failed/captured when finalize says so.
    if (status === "captured" && cols.payment_status !== "captured") return true;
  }

  if (UNSETTLED_PAYMENT_STATUSES.has(status)) return true;
  if (!hold || hold === "draft") return true;

  if (!args.finalizeSuccess && UNSETTLED_PAYMENT_STATUSES.has(status)) return true;
  if (
    cols.payment_status === "payment_shortfall" &&
    status !== "payment_shortfall" &&
    status !== "captured"
  ) {
    return true;
  }
  if (cols.payment_status === "captured" && status !== "captured") return true;
  if (cols.payment_status === "capture_failed" && status !== "capture_failed") return true;

  return false;
}
