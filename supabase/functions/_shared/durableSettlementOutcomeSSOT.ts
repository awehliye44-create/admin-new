/**
 * P0 #1 — durable settlement columns after finalize-trip-and-capture /
 * same-isolate tip-window finalize. Completed PLATFORM_COLLECTED card trips
 * must not remain authorized+draft with empty payment_hold_status.
 *
 * Canonical SSOT for both the HTTP finalize path and
 * finalizeTipWindowCaptureImmediate — never invent a second settlement map.
 */

import type { AnySupabaseClient } from "./supabaseClientTypes.ts";

export type DurableSettlementColumns = {
  payment_status: string;
  payment_hold_status: string;
};

export function durableSettlementColumns(
  status: string,
  success: boolean,
): DurableSettlementColumns {
  const s = String(status ?? "").toLowerCase();
  // already_captured may only stamp trips captured when the producer used
  // provider-confirmed COMPLETED/CAPTURED evidence (#89E / MK-261125-002).
  // A premature trips.capture_amount_pence stamp must never reach this path.
  if (
    success &&
    (s === "captured" || s === "completed" || s === "already_captured" ||
      (s.includes("captured") && !s.includes("shortfall") && !s.includes("partial") &&
        !s.includes("unconfirmed")))
  ) {
    return { payment_status: "captured", payment_hold_status: "captured" };
  }
  // Tip shortfall / tip_* statuses are not fare payment_shortfall.
  const tipOutcome =
    s.startsWith("tip_") ||
    s.includes("tip_shortfall") ||
    s.includes("tip_authorisation") ||
    s.includes("tip_authorization") ||
    s.includes("tip_window") ||
    s.includes("tip_not_collected");
  if (
    !tipOutcome &&
    (s.includes("shortfall") ||
      s.includes("recovery") ||
      s === "partial_capture_only" ||
      s === "payment_recovery_required")
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
  // MK-260922-001: success=true with status "authorized" must NOT invent captured.
  // captureRevolutOrder can return AUTHORISED while the hold is still open; the old
  // default stamped trips.payment_status=captured and sealed the tip window.
  if (
    s === "authorized" ||
    s === "authorised" ||
    s === "tip_window_open" ||
    s === "preauth_authorized" ||
    s === "preauth_authorised" ||
    s === "tip_authorisation_declined"
  ) {
    return {
      payment_status: "authorized",
      payment_hold_status: s === "tip_window_open"
        ? "tip_window_open"
        : s === "tip_authorisation_declined"
        ? "tip_authorisation_declined"
        : "authorized",
    };
  }
  // Unknown status: never invent captured from success alone.
  return {
    payment_status: success ? "authorized" : "capture_failed",
    payment_hold_status: s || (success ? "authorized" : "capture_failed"),
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
    // Confirmed capture is sticky. A later finalize that is not itself captured
    // must not downgrade payment_status to authorized (#108).
    // Explicit shortfall / refund outcomes may still be persisted.
    if (status === "captured" && cols.payment_status !== "captured") {
      const next = cols.payment_status;
      if (next === "payment_shortfall" || next === "refunded") return true;
      return false;
    }
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

/** Unconditional durable stamp (provider_authorisation_missing / catch paths). */
export async function persistDurableSettlementOutcome(
  supabase: AnySupabaseClient,
  tripId: string,
  status: string,
  success: boolean,
): Promise<void> {
  const cols = durableSettlementColumns(status, success);
  await supabase.from("trips").update({
    payment_status: cols.payment_status,
    payment_hold_status: cols.payment_hold_status,
    updated_at: new Date().toISOString(),
  }).eq("id", tripId);
}

/**
 * Persist only when the trip still lacks a matching durable outcome.
 * Captured stays sticky (#108).
 */
export async function persistDurableSettlementOutcomeIfNeeded(
  supabase: AnySupabaseClient,
  tripId: string,
  finalizeSuccess: boolean,
  finalizeStatus: string,
): Promise<void> {
  const cols = durableSettlementColumns(finalizeStatus, finalizeSuccess);
  const { data: fresh } = await supabase
    .from("trips")
    .select("payment_status, payment_hold_status, payment_state")
    .eq("id", tripId)
    .maybeSingle();

  if (
    !needsDurableSettlementPersist({
      paymentStatus: fresh?.payment_status,
      paymentHoldStatus: fresh?.payment_hold_status,
      paymentState: fresh?.payment_state,
      finalizeSuccess,
      finalizeStatus,
    })
  ) {
    return;
  }

  await supabase.from("trips").update({
    payment_status: cols.payment_status,
    payment_hold_status: cols.payment_hold_status,
    updated_at: new Date().toISOString(),
  }).eq("id", tripId);
}
