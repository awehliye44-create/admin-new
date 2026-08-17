/**
 * Canonical post-capture wallet posting (not Financial Reconciliation).
 *
 * Payment Sessions confirms capture → this service calculates/persists settlement
 * stamps via tripSettlement.ts (fresh capture only) → Driver Wallet Ledger inserts
 * one TRIP_EARNING_NET. Recovery reads saved stamps only.
 * If posting fails, capture stays captured. FR only reports WALLET_MISMATCH.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import { creditCapturedCardTripLedger } from "./onecabFinanceLedger.ts";
import { FINANCIAL_MODEL_VIOLATION, SERVICE_AREA_FINANCIAL_MODEL } from "./commissionWalletSSOT.ts";
import {
  mayRetryWalletPosting,
  paymentSessionAllowsWalletPosting,
} from "./postCaptureSettlementBoundary.ts";
import { recordWalletPostingFailureMetadata } from "./walletPostingMismatchSSOT.ts";
import {
  resolveCapturedTripEarningNetPence,
  tripSettlementDbColumns,
  type TripSettlementTripRow,
} from "./tripSettlement.ts";

/** Saved stamps only — never calls tripSettlement.ts. */
export function recoveryWalletCreditFromSavedStamps(trip: Record<string, unknown>): {
  expectedCredit: number;
  tipPence: number;
  commissionPct?: number;
} {
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
  return {
    expectedCredit,
    tipPence,
    commissionPct: Number.isFinite(pct) ? pct : undefined,
  };
}

async function loadPaymentSessionCaptureGate(
  supabase: SupabaseClient,
  tripId: string,
): Promise<Record<string, unknown> | null> {
  const { data } = await supabase
    .from("payment_sessions")
    .select("status, provider_state, captured_amount_pence, provider_state_verified_at, purpose")
    .eq("trip_id", tripId)
    .neq("purpose", "PAYMENT_RECOVERY")
    .order("captured_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data && typeof data === "object" ? data as Record<string, unknown> : null;
}

async function postedTripEarningNetPence(
  supabase: SupabaseClient,
  tripId: string,
): Promise<number> {
  const { data } = await supabase
    .from("driver_wallet_ledger")
    .select("amount_pence")
    .eq("related_trip_id", tripId)
    .eq("type", "TRIP_EARNING_NET");
  if (!Array.isArray(data)) return 0;
  return data.reduce((sum, row) => sum + Math.max(0, Math.round(Number(row.amount_pence) || 0)), 0);
}

export async function applyCanonicalSettlementAfterCapture(args: {
  supabase: SupabaseClient;
  tripId: string;
  trip: Record<string, unknown>;
  captureAmountPence: number;
  tipPence?: number;
  /** fresh_capture: this request just captured. recovery: already-captured posting retry. */
  mode?: "fresh_capture" | "recovery";
  /** Test/ops override for the historical posting boundary. */
  activatedAtMs?: number | null;
}): Promise<void> {
  const tripId = String(args.tripId);
  const driverId = args.trip.driver_id ? String(args.trip.driver_id) : "";
  if (
    String(args.trip.financial_model ?? "").toUpperCase()
    === SERVICE_AREA_FINANCIAL_MODEL.DRIVER_COLLECTED_COMMISSION_WALLET
  ) {
    throw new Error(
      `${FINANCIAL_MODEL_VIOLATION}: TRIP_EARNING_NET forbidden on DRIVER_COLLECTED_COMMISSION_WALLET`,
    );
  }
  if (!tripId || !driverId) {
    console.log("[applyCanonicalSettlementAfterCapture] skip — missing trip or driver", {
      trip_id: tripId || null,
    });
    return;
  }

  const mode = args.mode ?? "fresh_capture";
  if (mode === "recovery") {
    const allowed = mayRetryWalletPosting({
      capture_completed_at_iso: typeof args.trip.captured_at === "string"
        ? args.trip.captured_at
        : null,
      trip_created_at_iso: typeof args.trip.created_at === "string"
        ? args.trip.created_at
        : null,
      activated_at_ms: args.activatedAtMs,
    });
    if (!allowed) {
      return;
    }
  }

  const session = await loadPaymentSessionCaptureGate(args.supabase, tripId);
  if (!paymentSessionAllowsWalletPosting(session)) {
    console.log("[applyCanonicalSettlementAfterCapture] skip — Payment Sessions capture not verified", {
      trip_id: tripId,
    });
    return;
  }

  let expectedCredit: number;
  let tipPence: number;
  let commissionPct: number | undefined;

  if (mode === "recovery") {
    const saved = recoveryWalletCreditFromSavedStamps(args.trip);
    expectedCredit = saved.expectedCredit;
    tipPence = args.tipPence != null ? Math.max(0, Math.round(Number(args.tipPence) || 0)) : saved.tipPence;
    commissionPct = saved.commissionPct;
  } else {
    const credit = resolveCapturedTripEarningNetPence({
      trip: args.trip as TripSettlementTripRow,
      captureAmountPence: args.captureAmountPence,
      tipPence: args.tipPence,
    });
    if (credit.settlement) {
      const { error: stampErr } = await args.supabase.from("trips").update({
        ...tripSettlementDbColumns(credit.settlement),
        capture_amount_pence: Math.max(0, Math.round(Number(args.captureAmountPence) || 0)),
        updated_at: new Date().toISOString(),
      }).eq("id", tripId);
      if (stampErr) {
        console.error("[applyCanonicalSettlementAfterCapture] settlement stamp persist failed", {
          trip_id: tripId,
          error: stampErr.message,
        });
        throw new Error(`settlement stamp persist failed: ${stampErr.message}`);
      }
    }
    expectedCredit = credit.driverNetPence;
    tipPence = credit.tipPence;
    commissionPct = credit.commissionPct;
  }

  try {
    const ledger = await creditCapturedCardTripLedger(args.supabase, {
      driverId,
      tripId,
      driverNetPence: expectedCredit,
      tipPence,
      currency: String(args.trip.currency_code ?? args.trip.currency ?? "GBP"),
      paymentId: args.trip.provider_order_id
        ? String(args.trip.provider_order_id)
        : null,
      commissionPct,
    });
    if (!ledger.credited && expectedCredit > 0) {
      throw new Error("ledger credit returned credited:false");
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[applyCanonicalSettlementAfterCapture] ledger credit failed", {
      trip_id: tripId,
      error: message,
    });
    const posted = await postedTripEarningNetPence(args.supabase, tripId);
    await recordWalletPostingFailureMetadata(args.supabase, {
      tripId,
      tripCode: args.trip.trip_code ? String(args.trip.trip_code) : null,
      expectedDriverCreditPence: Math.round(Number(args.trip.driver_net_pence) || expectedCredit),
      postedDriverCreditPence: posted,
      errorMessage: message,
    });
    throw err;
  }
}
