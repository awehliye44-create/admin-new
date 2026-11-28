// @ts-nocheck
/**
 * ONECAB finance ledger SSOT — shared calculations and capture/settlement helpers.
 * Financial Reconciliation consumes these formulas; ledger is source of truth.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import { tripBlocksDriverWalletLedgerPosting } from "./commissionWalletDeduction.ts";
import { FINANCIAL_MODEL_VIOLATION } from "./commissionWalletSSOT.ts";
import { readTripEarningNetLedgerState } from "./tripEarningNetLedgerReadback.ts";
import {
  PENDING_ENTITLEMENT_BALANCE_EXCLUDED_TYPES,
  releaseTripEarningPendingIfPresent,
} from "./tripEarningPendingSSOT.ts";

export const CAPTURED_PAYMENT_STATUSES = new Set(["captured", "paid", "succeeded"]);

/** Ledger types excluded from wallet balance (informational / ONECAB-only — never driver money). */
export const BALANCE_EXCLUDED_LEDGER_TYPES = [
  "PLATFORM_COMMISSION",
  "PLATFORM_COMMISSION_GROSS",
  "PLATFORM_COMMISSION_NET",
  "COMPANY_COMMISSION",
  "COMMISSION_REVERSAL",
  "PAYMENT_PROVIDER_FEE",
  "PAYMENT_PROVIDER_FEE_ADJUSTMENT",
  "PROVIDER_FEE_REVERSAL",
  "CASH_TRIP_EARNING",
  // Slice 6: hold/release audit rows must not change live wallet balance.
  "PAYOUT_RESERVATION_HOLD",
  "PAYOUT_RESERVATION_RELEASE",
  // #98: pending entitlement is visible in Today/Activity, not live withdrawable liability.
  ...PENDING_ENTITLEMENT_BALANCE_EXCLUDED_TYPES,
] as const;

export const REVERSAL_LEDGER_TYPE = "LEDGER_REVERSAL";

export const DEBT_RECOVERY_SOURCE = "CARD_EARNINGS_OFFSET";

export type LedgerRow = {
  type: string;
  amount_pence: number;
  related_trip_id?: string | null;
  created_at?: string;
};

export type TripPaymentRow = {
  id: string;
  payment_method?: string | null;
  payment_status?: string | null;
};

export function isCashPaymentMethod(method: string | null | undefined): boolean {
  return String(method ?? "").trim().toLowerCase() === "cash";
}

export function isCardPaymentCaptured(args: {
  tripPaymentStatus?: string | null;
  paymentStatus?: string | null;
}): boolean {
  const pay = String(args.paymentStatus ?? "").toLowerCase();
  if (CAPTURED_PAYMENT_STATUSES.has(pay)) return true;
  const trip = String(args.tripPaymentStatus ?? "").toLowerCase();
  return CAPTURED_PAYMENT_STATUSES.has(trip);
}

export function sumLedgerAbs(
  ledger: LedgerRow[],
  type: string,
): number {
  return ledger
    .filter((r) => r.type === type)
    .reduce((s, r) => s + Math.abs(r.amount_pence ?? 0), 0);
}

/** Ledger-proven outstanding cash commission — debt minus DEBT_RECOVERY only (COMMISSION_RECOVERED is reporting). */
export function computeCashCommissionOutstanding(ledger: LedgerRow[]): number {
  const debt = sumLedgerAbs(ledger, "CASH_COMMISSION_DEBT");
  const recovered = sumLedgerAbs(ledger, "DEBT_RECOVERY");
  return Math.max(0, debt - recovered);
}

/** Single wallet balance from ledger — SSOT for cache, net_balance, and available_now. */
export function computeLedgerWalletBalancePence(ledger: LedgerRow[]): number {
  let total = 0;
  for (const entry of ledger) {
    if ((BALANCE_EXCLUDED_LEDGER_TYPES as readonly string[]).includes(entry.type)) continue;
    total += entry.amount_pence ?? 0;
  }
  return total;
}

// NOTE: legacy `computeAvailableNowPence` and `computeNextWeeklyPayoutPence`
// formulas have been permanently removed (double-counted cash debt + card
// recovery). The single SSOT is `availablePayoutPence(walletBalance)` in
// `payoutAvailability.ts`.

export async function logFinanceAuditEvent(
  supabase: SupabaseClient,
  eventType: string,
  details: Record<string, unknown>,
  tripId?: string | null,
  driverId?: string | null,
): Promise<void> {
  try {
    await supabase.rpc("log_audit_event", {
      p_event_type: eventType,
      p_trip_id: tripId ?? null,
      p_driver_id: driverId ?? null,
      p_details: details,
    });
  } catch (e) {
    console.warn("[onecabFinanceLedger] log_audit_event failed", e);
  }
}

export async function reversePhantomCardCreditsForTrip(
  supabase: SupabaseClient,
  args: {
    tripId: string;
    driverId: string;
    reason?: string;
  },
): Promise<number> {
  const reason = args.reason ?? "Card capture failed — reversing phantom driver credit";

  const { data: existingReversal } = await supabase
    .from("driver_wallet_ledger")
    .select("id")
    .eq("related_trip_id", args.tripId)
    .eq("type", REVERSAL_LEDGER_TYPE)
    .maybeSingle();

  if (existingReversal) return 0;

  const { data: entries } = await supabase
    .from("driver_wallet_ledger")
    .select("id, type, amount_pence")
    .eq("driver_id", args.driverId)
    .eq("related_trip_id", args.tripId)
    .in("type", ["TRIP_EARNING_NET", "DRIVER_TIP_CREDIT"]);

  let totalPence = 0;
  const reversedRefs: string[] = [];
  for (const entry of entries ?? []) {
    const amount = entry.amount_pence ?? 0;
    if (amount <= 0) continue;
    totalPence += amount;
    reversedRefs.push(`${entry.id}:${entry.type}`);
  }

  if (totalPence <= 0) return 0;

  const { error } = await supabase.from("driver_wallet_ledger").insert({
    driver_id: args.driverId,
    related_trip_id: args.tripId,
    type: REVERSAL_LEDGER_TYPE,
    amount_pence: -totalPence,
    description: `${reason} (reverses ${reversedRefs.join(", ")})`,
  });

  return error ? 0 : totalPence;
}

export async function applyCardDebtRecoveryOnCapture(
  supabase: SupabaseClient,
  args: {
    driverId: string;
    tripId: string;
    paymentId?: string | null;
    cardDriverCreditPence: number;
    currency?: string;
  },
): Promise<{ recovery_pence: number }> {
  if (args.cardDriverCreditPence <= 0) {
    return { recovery_pence: 0 };
  }

  const { data: ledgerRows } = await supabase
    .from("driver_wallet_ledger")
    .select("type, amount_pence")
    .eq("driver_id", args.driverId);

  const outstanding = computeCashCommissionOutstanding(ledgerRows ?? []);
  const recovery = Math.min(args.cardDriverCreditPence, outstanding);
  if (recovery <= 0) return { recovery_pence: 0 };

  const { data: existing } = await supabase
    .from("driver_wallet_ledger")
    .select("id")
    .eq("driver_id", args.driverId)
    .eq("related_trip_id", args.tripId)
    .eq("type", "DEBT_RECOVERY")
    .maybeSingle();

  if (existing) return { recovery_pence: recovery };

  const description = `Cash commission recovered from card earnings (${DEBT_RECOVERY_SOURCE})`;

  await supabase.from("driver_wallet_ledger").insert({
    driver_id: args.driverId,
    related_trip_id: args.tripId,
    type: "DEBT_RECOVERY",
    amount_pence: -recovery,
    currency: args.currency ?? "GBP",
    description,
  });

  await supabase.from("driver_wallet_ledger").insert({
    driver_id: args.driverId,
    related_trip_id: args.tripId,
    type: "COMMISSION_RECOVERED",
    amount_pence: recovery,
    currency: args.currency ?? "GBP",
    description: `${description} — ONECAB commission recovered`,
  });

  return { recovery_pence: recovery };
}

export async function creditCapturedCardTripLedger(
  supabase: SupabaseClient,
  args: {
    driverId: string;
    tripId: string;
    driverNetPence: number;
    tipPence: number;
    currency?: string;
    paymentId?: string | null;
    commissionPct?: number;
    /**
     * #111E — optional TEN description / metadata so terminal-fee settlement
     * reuses this canonical writer (exactly-once readback + unique index)
     * without inventing a second insert path.
     */
    description?: string | null;
    metadata?: Record<string, unknown> | null;
    /** Skip tip credit + card debt recovery (terminal fees have neither). */
    skipTipAndDebtRecovery?: boolean;
  },
): Promise<{ credited: boolean; recovery_pence: number }> {
  if (await tripBlocksDriverWalletLedgerPosting(supabase, args.tripId)) {
    throw new Error(
      `${FINANCIAL_MODEL_VIOLATION}: TRIP_EARNING_NET forbidden on DRIVER_COLLECTED_COMMISSION_WALLET`,
    );
  }

  const currency = args.currency ?? "GBP";
  const description =
    typeof args.description === "string" && args.description.trim()
      ? args.description.trim()
      : args.commissionPct != null
      ? `Trip earning (net of ${args.commissionPct}% commission)`
      : "Trip earning (net of commission)";
  const metadata =
    args.metadata && typeof args.metadata === "object" && !Array.isArray(args.metadata)
      ? args.metadata
      : null;

  const readbackBefore = await readTripEarningNetLedgerState(supabase, args.tripId);
  if (readbackBefore.count === 1) {
    if (args.driverNetPence > 0 && readbackBefore.totalPence !== args.driverNetPence) {
      throw Object.assign(
        new Error(
          `TRIP_EARNING_NET amount mismatch: expected ${args.driverNetPence}p, found ${readbackBefore.totalPence}p`,
        ),
        { code: "WALLET_AMOUNT_MISMATCH" },
      );
    }
    // TEN already posted. Still release any stranded PENDING, then allow tip credit.
    await releaseTripEarningPendingIfPresent(supabase, {
      tripId: args.tripId,
      driverId: args.driverId,
      currency,
    });
  } else if (readbackBefore.count > 1) {
    throw Object.assign(
      new Error(`duplicate TRIP_EARNING_NET rows for trip ${args.tripId}`),
      { code: "DUPLICATE_WALLET_CREDIT" },
    );
  } else if (args.driverNetPence > 0) {
    // #98: append-only supersession — RELEASE open PENDING before confirmed TEN.
    await releaseTripEarningPendingIfPresent(supabase, {
      tripId: args.tripId,
      driverId: args.driverId,
      currency,
    });

    const insertRow: Record<string, unknown> = {
      driver_id: args.driverId,
      related_trip_id: args.tripId,
      type: "TRIP_EARNING_NET",
      amount_pence: args.driverNetPence,
      currency,
      description,
    };
    if (metadata) insertRow.metadata = metadata;

    const { error } = await supabase.from("driver_wallet_ledger").insert(insertRow);
    if (error && error.code !== "23505") throw error;

    const readbackAfter = await readTripEarningNetLedgerState(supabase, args.tripId);
    if (readbackAfter.count === 0) {
      throw Object.assign(
        new Error("TRIP_EARNING_NET insert returned no error but ledger readback is empty"),
        { code: "WALLET_CREDIT_MISSING" },
      );
    }
    if (readbackAfter.count > 1) {
      throw Object.assign(
        new Error(`duplicate TRIP_EARNING_NET rows after insert for trip ${args.tripId}`),
        { code: "DUPLICATE_WALLET_CREDIT" },
      );
    }
    if (readbackAfter.totalPence !== args.driverNetPence) {
      throw Object.assign(
        new Error(
          `TRIP_EARNING_NET amount mismatch after insert: expected ${args.driverNetPence}p, found ${readbackAfter.totalPence}p`,
        ),
        { code: "WALLET_AMOUNT_MISMATCH" },
      );
    }
  }

  if (args.skipTipAndDebtRecovery === true) {
    return { credited: true, recovery_pence: 0 };
  }

  if (args.tipPence > 0) {
    const { data: existingTip } = await supabase
      .from("driver_wallet_ledger")
      .select("id")
      .eq("related_trip_id", args.tripId)
      .eq("type", "DRIVER_TIP_CREDIT")
      .maybeSingle();

    if (!existingTip) {
      const { error: tipErr } = await supabase.from("driver_wallet_ledger").insert({
        driver_id: args.driverId,
        related_trip_id: args.tripId,
        type: "DRIVER_TIP_CREDIT",
        amount_pence: args.tipPence,
        currency,
        description: "Tip from passenger",
      });
      if (tipErr && tipErr.code !== "23505") throw tipErr;
    }
  }

  const recovery = await applyCardDebtRecoveryOnCapture(supabase, {
    driverId: args.driverId,
    tripId: args.tripId,
    paymentId: args.paymentId,
    cardDriverCreditPence: args.driverNetPence + args.tipPence,
    currency,
  });

  return { credited: true, recovery_pence: recovery.recovery_pence };
}

export async function recordCardCaptureFailure(
  supabase: SupabaseClient,
  args: {
    tripId: string;
    driverId?: string | null;
    message: string;
    providerPaymentIntentId?: string | null;
  },
): Promise<void> {
  const errorText = args.message.slice(0, 2000);
  const now = new Date().toISOString();

  await supabase
    .from("trips")
    .update({
      payment_status: "capture_failed",
      // Never leave completed card trips in draft with no settlement outcome.
      payment_hold_status: "capture_failed",
      updated_at: now,
    })
    .eq("id", args.tripId);

  await supabase
    .from("trip_finance")
    .update({
      financial_status: "PAYMENT_NOT_CAPTURED",
      updated_at: now,
    })
    .eq("trip_id", args.tripId);

  let paymentQuery = supabase
    .from("payments")
    .update({
      status: "capture_failed",
      last_error: errorText,
      updated_at: now,
    })
    .eq("trip_id", args.tripId);

  if (args.providerPaymentIntentId) {
    paymentQuery = paymentQuery.eq("provider_payment_id", args.providerPaymentIntentId);
  }
  await paymentQuery;

  let driverId = args.driverId ?? null;
  if (!driverId) {
    const { data: trip } = await supabase
      .from("trips")
      .select("driver_id")
      .eq("id", args.tripId)
      .maybeSingle();
    driverId = trip?.driver_id ?? null;
  }

  if (driverId) {
    await reversePhantomCardCreditsForTrip(supabase, {
      tripId: args.tripId,
      driverId,
    });
  }

  await logFinanceAuditEvent(supabase, "CARD_CAPTURE_FAILED", {
    message: errorText,
    provider_payment_id: args.providerPaymentIntentId ?? null,
    reversed_phantom_credits: true,
  }, args.tripId, driverId);
}

export type PayoutEligibilityInput = {
  provider_account_id?: string | null;
  payouts_enabled?: boolean | null;
  charges_enabled?: boolean | null;
  onboarding_complete?: boolean | null;
  external_account_exists?: boolean | null;
  requirements_currently_due?: string[] | null;
};

export type PayoutEligibility = {
  provider_connected: boolean;
  payout_eligible: boolean;
  settlement_status: "eligible" | "needs_attention" | "not_connected";
};
