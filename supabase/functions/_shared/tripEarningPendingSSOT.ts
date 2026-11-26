/**
 * #93B / #98 — TRIP_EARNING_PENDING → RELEASE → TEN.
 *
 * PENDING = earned net fare awaiting payment confirmation (not withdrawable, no clearing).
 * RELEASE = append-only offset before confirmed TEN (never DELETE PENDING).
 * Tip stays DRIVER_TIP_CREDIT after capture only.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import { tripBlocksDriverWalletLedgerPosting } from "./commissionWalletDeduction.ts";
import { FINANCIAL_MODEL_VIOLATION } from "./commissionWalletSSOT.ts";
import { recordPaymentFinancialEvent } from "./paymentFinancialDiagnosticsSSOT.ts";

export const TRIP_EARNING_PENDING_TYPE = "TRIP_EARNING_PENDING";
export const TRIP_EARNING_PENDING_RELEASE_TYPE = "TRIP_EARNING_PENDING_RELEASE";

/** Included in Today/period earnings (with RELEASE so net = one economic amount). */
export const TODAY_EARNINGS_PENDING_TYPES = [
  TRIP_EARNING_PENDING_TYPE,
  TRIP_EARNING_PENDING_RELEASE_TYPE,
] as const;

/** Excluded from live wallet liability and payout eligibility. */
export const PENDING_ENTITLEMENT_BALANCE_EXCLUDED_TYPES = [
  TRIP_EARNING_PENDING_TYPE,
  TRIP_EARNING_PENDING_RELEASE_TYPE,
] as const;

export function pendingEntitlementAmountPence(args: {
  driverNetPence?: number | null;
  airportChargePence?: number | null;
}): number {
  return Math.max(
    0,
    Math.round(Number(args.driverNetPence) || 0)
      + Math.round(Number(args.airportChargePence) || 0),
  );
}

export type CreditTripEarningPendingResult = {
  ok: boolean;
  inserted: boolean;
  reason: string;
  ledger_id?: string | null;
  amount_pence?: number;
  message?: string;
};

/**
 * Idempotent PENDING insert via SECURITY DEFINER RPC.
 * Call after completion settlement stamps for PLATFORM_COLLECTED card trips.
 */
export async function creditTripEarningPending(
  supabase: SupabaseClient,
  args: {
    tripId: string;
    driverId: string;
    amountPence: number;
    currency?: string;
    description?: string;
  },
): Promise<CreditTripEarningPendingResult> {
  if (await tripBlocksDriverWalletLedgerPosting(supabase, args.tripId)) {
    return {
      ok: false,
      inserted: false,
      reason: "financial_model_violation",
      message: `${FINANCIAL_MODEL_VIOLATION}: PENDING forbidden on DRIVER_COLLECTED`,
    };
  }

  const amount = Math.max(0, Math.round(Number(args.amountPence) || 0));
  if (amount <= 0) {
    return { ok: false, inserted: false, reason: "amount_non_positive" };
  }

  const { data, error } = await supabase.rpc("credit_trip_earning_pending", {
    p_trip_id: args.tripId,
    p_driver_id: args.driverId,
    p_amount_pence: amount,
    p_currency: args.currency ?? "GBP",
    p_description: args.description
      ?? "Trip earning pending payment confirmation",
  });

  if (error) {
    const message = error.message;
    console.error("[tripEarningPendingSSOT] credit_trip_earning_pending rpc_error", {
      trip_id: args.tripId,
      driver_id: args.driverId,
      amount_pence: amount,
      message,
      code: (error as { code?: string }).code ?? null,
    });
    await recordPaymentFinancialEvent(supabase, {
      tripId: args.tripId,
      eventType: "pending_entitlement_rpc_failed",
      declineCode: "rpc_error",
      requestedAmountPence: amount,
      detail: {
        reason: "rpc_error",
        message,
        source: "creditTripEarningPending",
        recovery_failed: true,
      },
    });
    return {
      ok: false,
      inserted: false,
      reason: "rpc_error",
      message,
    };
  }

  const row = (data && typeof data === "object") ? data as Record<string, unknown> : {};
  const result: CreditTripEarningPendingResult = {
    ok: row.ok === true,
    inserted: row.inserted === true,
    reason: String(row.reason ?? "unknown"),
    ledger_id: row.ledger_id != null ? String(row.ledger_id) : null,
    amount_pence: row.amount_pence != null ? Math.round(Number(row.amount_pence)) : amount,
    message: row.message != null ? String(row.message) : undefined,
  };

  // Soft RPC success with ok:false (e.g. check_violation) must still escalate.
  if (!result.ok && result.reason !== "amount_non_positive" &&
    result.reason !== "financial_model_violation") {
    await recordPaymentFinancialEvent(supabase, {
      tripId: args.tripId,
      eventType: "pending_entitlement_persist_failed",
      declineCode: result.reason,
      requestedAmountPence: amount,
      detail: {
        reason: result.reason,
        message: result.message ?? null,
        source: "creditTripEarningPending",
        recovery_failed: true,
      },
    });
  }

  return result;
}

export type ReleaseTripEarningPendingResult = {
  released: boolean;
  reason: string;
  pendingAmountPence: number;
};

/**
 * Append PENDING_RELEASE (−amount) when open PENDING exists.
 * Idempotent: if RELEASE already present, no-op.
 * Call immediately before TEN insert in creditCapturedCardTripLedger.
 */
export async function releaseTripEarningPendingIfPresent(
  supabase: SupabaseClient,
  args: {
    tripId: string;
    driverId: string;
    currency?: string;
  },
): Promise<ReleaseTripEarningPendingResult> {
  const { data: pending } = await supabase
    .from("driver_wallet_ledger")
    .select("id, amount_pence, driver_id")
    .eq("related_trip_id", args.tripId)
    .eq("type", TRIP_EARNING_PENDING_TYPE)
    .maybeSingle();

  if (!pending) {
    return { released: false, reason: "no_pending", pendingAmountPence: 0 };
  }

  const { data: existingRelease } = await supabase
    .from("driver_wallet_ledger")
    .select("id")
    .eq("related_trip_id", args.tripId)
    .eq("type", TRIP_EARNING_PENDING_RELEASE_TYPE)
    .maybeSingle();

  if (existingRelease) {
    return {
      released: false,
      reason: "already_released",
      pendingAmountPence: Math.abs(Math.round(Number(pending.amount_pence) || 0)),
    };
  }

  const pendingAmount = Math.abs(Math.round(Number(pending.amount_pence) || 0));
  if (pendingAmount <= 0) {
    return { released: false, reason: "pending_amount_invalid", pendingAmountPence: 0 };
  }

  const { error } = await supabase.from("driver_wallet_ledger").insert({
    driver_id: args.driverId || pending.driver_id,
    related_trip_id: args.tripId,
    type: TRIP_EARNING_PENDING_RELEASE_TYPE,
    amount_pence: -pendingAmount,
    currency: args.currency ?? "GBP",
    description: "Pending trip earning confirmed — superseded by TRIP_EARNING_NET",
    metadata: {
      source: "release_trip_earning_pending",
      pending_ledger_id: pending.id,
      awaiting_payment_confirmation: false,
    },
  });

  if (error && error.code !== "23505") throw error;

  return {
    released: true,
    reason: error?.code === "23505" ? "already_released_race" : "released",
    pendingAmountPence: pendingAmount,
  };
}

/** Prefer TEN amount for trip display; else open PENDING (no RELEASE yet). */
export function resolveVisibleTripEarningPence(rows: Array<{
  type?: string | null;
  amount_pence?: number | null;
}>): { amountPence: number; state: "confirmed" | "awaiting_confirmation" | "none" } {
  let ten = 0;
  let pending = 0;
  let released = 0;
  for (const row of rows) {
    const type = String(row.type ?? "").toUpperCase();
    const amt = Math.round(Number(row.amount_pence) || 0);
    if (type === "TRIP_EARNING_NET") ten += Math.max(0, amt);
    else if (type === TRIP_EARNING_PENDING_TYPE) pending += Math.max(0, amt);
    else if (type === TRIP_EARNING_PENDING_RELEASE_TYPE) released += Math.abs(amt);
  }
  if (ten > 0) return { amountPence: ten, state: "confirmed" };
  if (pending > 0 && released <= 0) {
    return { amountPence: pending, state: "awaiting_confirmation" };
  }
  return { amountPence: 0, state: "none" };
}
