/**
 * Driver Wallet Ledger — consume customer capture FROM Payment Sessions only.
 * Never invent captured amounts from trips / authorised / fare.
 */

import { confirmedCapturePence } from "./financialReconciliationSSOT.ts";
import type { EarningSettlementInput } from "./payoutEligibilitySSOT.ts";

export type WalletSettlementSourceRow = {
  trip_id?: string | null;
  settlement_status?: string | null;
  paid_in_batch_id?: string | null;
  allocated_to_payout?: boolean | null;
  allocated_amount_pence?: number | null;
  /** Ledger TRIP_EARNING_NET amount joined on settlement. */
  ledger_amount_pence?: number | null;
};

export type WalletTripSettlementMeta = {
  payment_method?: string | null;
  /** Trip History settlement expected fare — not customer capture. */
  final_customer_fare_pence?: number | null;
};

export type WalletPaymentSessionCapture = {
  trip_id?: string | null;
  captured_amount_pence?: number | null;
};

function isCashPaymentMethod(method: string | null | undefined): boolean {
  const m = String(method ?? "").trim().toLowerCase();
  return m === "cash" || m.includes("cash");
}

/** Aggregate confirmed Payment Sessions captures per trip. */
export function buildSessionCaptureByTripId(
  sessions: WalletPaymentSessionCapture[],
): Map<string, number> {
  const byTrip = new Map<string, number>();
  for (const s of sessions) {
    if (!s.trip_id) continue;
    const amt = confirmedCapturePence(s.captured_amount_pence);
    if (amt == null) continue;
    byTrip.set(s.trip_id, (byTrip.get(s.trip_id) ?? 0) + amt);
  }
  return byTrip;
}

/**
 * Build earning settlement inputs for wallet Available/Pending.
 * Captured customer payment comes only from Payment Sessions.
 */
export function buildWalletEarningInputsFromPaymentSessions(args: {
  settlements: WalletSettlementSourceRow[];
  sessionCaptureByTripId: Map<string, number>;
  tripMetaById: Map<string, WalletTripSettlementMeta>;
}): EarningSettlementInput[] {
  return args.settlements.map((s) => {
    const tripId = String(s.trip_id ?? "");
    const trip = tripId ? args.tripMetaById.get(tripId) : undefined;
    const method = trip?.payment_method ?? "card";
    const cash = isCashPaymentMethod(method);
    const sessionCaptured = tripId ? (args.sessionCaptureByTripId.get(tripId) ?? null) : null;
    const captureOk = cash ? true : sessionCaptured != null && sessionCaptured > 0;

    return {
      amount_pence: Math.max(0, Number(s.ledger_amount_pence ?? 0)),
      settlement_status: s.settlement_status === "settled"
        ? "settled"
        : s.settlement_status === "failed"
        ? "failed"
        : "pending",
      paid_in_batch_id: (s.paid_in_batch_id as string | null) ?? null,
      allocated_to_payout: s.allocated_to_payout === true,
      allocated_amount_pence: Number(s.allocated_amount_pence ?? 0),
      trip_completed: true,
      payment_captured: captureOk,
      // Cash: no Payment Session capture. Digital: sessions only (never trips.capture).
      captured_amount_pence: cash ? null : sessionCaptured,
      required_customer_fare_pence: trip?.final_customer_fare_pence ?? null,
      capture_mismatch_unresolved: cash ? false : !captureOk,
      payment_method: method,
    };
  });
}
