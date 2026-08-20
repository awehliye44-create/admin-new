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
  isPaymentSessionLifecycleMismatch,
} from "./postCaptureSettlementBoundary.ts";
import { finalizePaymentSessionLifecycleMismatch } from "./paymentSessionLifecycleFinalizer.ts";
import { recordWalletPostingFailureMetadata } from "./walletPostingMismatchSSOT.ts";
import {
  postingWalletMismatch,
  type PostCaptureSettlementResult,
} from "./postCaptureSettlementResult.ts";
import {
  loadPaymentSessionCaptureGate,
  PAYMENT_SESSION_GATE_STATUS,
  type PaymentSessionGateRow,
} from "./paymentSessionCaptureGateSSOT.ts";
import {
  readTripEarningNetLedgerState,
  reconcileTripEarningNetLedgerReadback,
} from "./tripEarningNetLedgerReadback.ts";
import {
  mergeFareSnapshotSettlementJson,
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

function supabaseErrorParts(err: unknown): { message: string; code: string | null } {
  if (err && typeof err === "object") {
    const rec = err as { message?: unknown; code?: unknown };
    const message = typeof rec.message === "string" ? rec.message : String(err);
    const code = typeof rec.code === "string" ? rec.code : null;
    return { message, code };
  }
  return { message: err instanceof Error ? err.message : String(err), code: null };
}

function resolveExpectedEntitlementPence(
  trip: Record<string, unknown>,
  mode: "fresh_capture" | "recovery",
  captureAmountPence: number,
  tipPenceArg?: number,
): { expectedCredit: number; tipPence: number; commissionPct?: number } {
  if (mode === "recovery") {
    const saved = recoveryWalletCreditFromSavedStamps(trip);
    return {
      expectedCredit: saved.expectedCredit,
      tipPence: tipPenceArg != null
        ? Math.max(0, Math.round(Number(tipPenceArg) || 0))
        : saved.tipPence,
      commissionPct: saved.commissionPct,
    };
  }
  const credit = resolveCapturedTripEarningNetPence({
    trip: trip as TripSettlementTripRow,
    captureAmountPence,
    tipPence: tipPenceArg,
  });
  return {
    expectedCredit: credit.driverNetPence,
    tipPence: credit.tipPence,
    commissionPct: credit.commissionPct,
  };
}

async function recordGateFailureAndReturn(args: {
  supabase: SupabaseClient;
  tripId: string;
  trip: Record<string, unknown>;
  driverId: string;
  expectedPence: number;
  postedPence: number;
  failureStage: string;
  paymentSessionId?: string | null;
  providerCaptureId?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  settlementStatus?: "SUCCEEDED" | "FAILED";
}): Promise<PostCaptureSettlementResult> {
  await recordWalletPostingFailureMetadata(args.supabase, {
    tripId: args.tripId,
    tripCode: args.trip.trip_code ? String(args.trip.trip_code) : null,
    driverId: args.driverId,
    paymentSessionId: args.paymentSessionId ?? null,
    providerCaptureId: args.providerCaptureId ?? null,
    expectedDriverCreditPence: args.expectedPence,
    postedDriverCreditPence: args.postedPence,
    failureStage: args.failureStage,
    errorCode: args.errorCode ?? null,
    errorMessage: args.errorMessage ?? null,
  });
  return postingWalletMismatch({
    settlement_status: args.settlementStatus ?? "FAILED",
    expectedPence: args.expectedPence,
    postedPence: args.postedPence,
  });
}

async function handlePaymentSessionGateQueryFailure(args: {
  supabase: SupabaseClient;
  tripId: string;
  trip: Record<string, unknown>;
  driverId: string;
  expectedPence: number;
  error: { code?: string; message: string };
}): Promise<PostCaptureSettlementResult> {
  console.error("[applyCanonicalSettlementAfterCapture] Payment Sessions gate query failed", {
    trip_id: args.tripId,
    error: args.error.message,
    code: args.error.code ?? null,
  });
  const posted = (await readTripEarningNetLedgerState(args.supabase, args.tripId).catch(() => ({
    count: 0,
    totalPence: 0,
    rows: [],
  }))).totalPence;
  return recordGateFailureAndReturn({
    ...args,
    postedPence: posted,
    failureStage: "PAYMENT_SESSION_GATE_QUERY",
    errorCode: args.error.code ?? null,
    errorMessage: args.error.message,
    settlementStatus: "FAILED",
  });
}

function gateFailureStageForSession(
  session: PaymentSessionGateRow | null,
  gateStatus?: string,
): string {
  if (gateStatus === PAYMENT_SESSION_GATE_STATUS.CAPTURE_AMBIGUOUS) {
    return "CAPTURE_AMBIGUOUS";
  }
  if (!session) return "PAYMENT_SESSION_MISSING";
  return "PAYMENT_SESSION_CAPTURE_UNVERIFIED";
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
}): Promise<PostCaptureSettlementResult> {
  const tripId = String(args.tripId);
  const driverId = args.trip.driver_id ? String(args.trip.driver_id) : "";
  const mode = args.mode ?? "fresh_capture";
  const entitlementPreview = resolveExpectedEntitlementPence(
    args.trip,
    mode,
    args.captureAmountPence,
    args.tipPence,
  );

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
    const posted = (await readTripEarningNetLedgerState(args.supabase, tripId).catch(() => ({
      count: 0,
      totalPence: 0,
      rows: [],
    }))).totalPence;
    return recordGateFailureAndReturn({
      supabase: args.supabase,
      tripId,
      trip: args.trip,
      driverId: driverId || "unknown",
      expectedPence: entitlementPreview.expectedCredit,
      postedPence: posted,
      failureStage: "MISSING_TRIP_OR_DRIVER",
      settlementStatus: "FAILED",
    });
  }

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
      return postingWalletMismatch({
        settlement_status: "FAILED",
        expectedPence: entitlementPreview.expectedCredit,
        postedPence: 0,
      });
    }
  }

  let gateLoad = await loadPaymentSessionCaptureGate(args.supabase, tripId);
  if (gateLoad.error) {
    return handlePaymentSessionGateQueryFailure({
      supabase: args.supabase,
      tripId,
      trip: args.trip,
      driverId,
      expectedPence: entitlementPreview.expectedCredit,
      error: gateLoad.error,
    });
  }
  if (
    gateLoad.gate_status === PAYMENT_SESSION_GATE_STATUS.PAYMENT_SESSION_MISSING
    || gateLoad.gate_status === PAYMENT_SESSION_GATE_STATUS.CAPTURE_AMBIGUOUS
  ) {
    const posted = (await readTripEarningNetLedgerState(args.supabase, tripId).catch(() => ({
      count: 0,
      totalPence: 0,
      rows: [],
    }))).totalPence;
    return recordGateFailureAndReturn({
      supabase: args.supabase,
      tripId,
      trip: args.trip,
      driverId,
      expectedPence: entitlementPreview.expectedCredit,
      postedPence: posted,
      failureStage: gateFailureStageForSession(null, gateLoad.gate_status),
      settlementStatus: "FAILED",
    });
  }
  let session = gateLoad.session;

  if (isPaymentSessionLifecycleMismatch(session)) {
    console.log(
      "[applyCanonicalSettlementAfterCapture] Payment Sessions lifecycle mismatch detected — finalizing",
      {
        trip_id: tripId,
        session_status: session?.status,
        provider_state: session?.provider_state,
        captured_amount_pence: session?.captured_amount_pence,
        financial_operation_state: session?.financial_operation_state,
      },
    );
    const finResult = await finalizePaymentSessionLifecycleMismatch(
      args.supabase,
      session as Record<string, unknown>,
      {
        tripId,
        source: "applyCanonicalSettlementAfterCapture",
        tripFinancialModel: String(args.trip.financial_model ?? ""),
      },
    );
    if (finResult.finalized) {
      gateLoad = await loadPaymentSessionCaptureGate(args.supabase, tripId);
      if (gateLoad.error) {
        return handlePaymentSessionGateQueryFailure({
          supabase: args.supabase,
          tripId,
          trip: args.trip,
          driverId,
          expectedPence: entitlementPreview.expectedCredit,
          error: gateLoad.error,
        });
      }
      if (
        gateLoad.gate_status === PAYMENT_SESSION_GATE_STATUS.PAYMENT_SESSION_MISSING
        || gateLoad.gate_status === PAYMENT_SESSION_GATE_STATUS.CAPTURE_AMBIGUOUS
      ) {
        const posted = (await readTripEarningNetLedgerState(args.supabase, tripId).catch(() => ({
          count: 0,
          totalPence: 0,
          rows: [],
        }))).totalPence;
        return recordGateFailureAndReturn({
          supabase: args.supabase,
          tripId,
          trip: args.trip,
          driverId,
          expectedPence: entitlementPreview.expectedCredit,
          postedPence: posted,
          failureStage: gateFailureStageForSession(null, gateLoad.gate_status),
          settlementStatus: "FAILED",
        });
      }
      session = gateLoad.session;
    } else {
      console.error(
        "[applyCanonicalSettlementAfterCapture] lifecycle mismatch finalization failed — wallet post blocked",
        { trip_id: tripId, error: finResult.error },
      );
      const posted = (await readTripEarningNetLedgerState(args.supabase, tripId).catch(() => ({
        count: 0,
        totalPence: 0,
        rows: [],
      }))).totalPence;
      return recordGateFailureAndReturn({
        supabase: args.supabase,
        tripId,
        trip: args.trip,
        driverId,
        expectedPence: entitlementPreview.expectedCredit,
        postedPence: posted,
        failureStage: "PAYMENT_SESSION_LIFECYCLE_FINALIZATION_FAILED",
        paymentSessionId: session?.id ? String(session.id) : null,
        providerCaptureId: session?.provider_capture_id
          ? String(session.provider_capture_id)
          : null,
        errorMessage: "reason" in finResult ? String(finResult.reason) : "lifecycle_finalization_failed",
        settlementStatus: "FAILED",
      });
    }
  }

  if (!paymentSessionAllowsWalletPosting(session)) {
    console.log("[applyCanonicalSettlementAfterCapture] skip — Payment Sessions capture not verified", {
      trip_id: tripId,
      session_status: session?.status ?? "null",
    });
    const posted = (await readTripEarningNetLedgerState(args.supabase, tripId).catch(() => ({
      count: 0,
      totalPence: 0,
      rows: [],
    }))).totalPence;
    return recordGateFailureAndReturn({
      supabase: args.supabase,
      tripId,
      trip: args.trip,
      driverId,
      expectedPence: entitlementPreview.expectedCredit,
      postedPence: posted,
      failureStage: gateFailureStageForSession(session, gateLoad.gate_status),
      paymentSessionId: session?.id ? String(session.id) : null,
      providerCaptureId: session?.provider_capture_id
        ? String(session.provider_capture_id)
        : null,
      settlementStatus: "FAILED",
    });
  }

  const paymentSessionId = session?.id ? String(session.id) : null;
  const providerCaptureId = session?.provider_capture_id
    ? String(session.provider_capture_id)
    : null;

  let expectedCredit: number;
  let tipPence: number;
  let commissionPct: number | undefined;

  if (mode === "recovery") {
    const saved = recoveryWalletCreditFromSavedStamps(args.trip);
    expectedCredit = saved.expectedCredit;
    tipPence = args.tipPence != null
      ? Math.max(0, Math.round(Number(args.tipPence) || 0))
      : saved.tipPence;
    commissionPct = saved.commissionPct;
  } else {
    const credit = resolveCapturedTripEarningNetPence({
      trip: args.trip as TripSettlementTripRow,
      captureAmountPence: args.captureAmountPence,
      tipPence: args.tipPence,
    });
    if (credit.settlement) {
      const existingSnap = args.trip.fare_snapshot_json;
      const fareSnapshotJson = mergeFareSnapshotSettlementJson(
        existingSnap && typeof existingSnap === "object"
          ? existingSnap as Record<string, unknown>
          : null,
        credit.settlement,
      );
      const { error: stampErr } = await args.supabase.from("trips").update({
        ...tripSettlementDbColumns(credit.settlement),
        fare_snapshot_json: fareSnapshotJson,
        capture_amount_pence: Math.max(0, Math.round(Number(args.captureAmountPence) || 0)),
        updated_at: new Date().toISOString(),
      }).eq("id", tripId);
      if (stampErr) {
        const parts = supabaseErrorParts(stampErr);
        console.error("[applyCanonicalSettlementAfterCapture] settlement stamp persist failed", {
          trip_id: tripId,
          error: parts.message,
        });
        const readback = await readTripEarningNetLedgerState(args.supabase, tripId).catch(() => ({
          count: 0,
          totalPence: 0,
          rows: [],
        }));
        await recordWalletPostingFailureMetadata(args.supabase, {
          tripId,
          tripCode: args.trip.trip_code ? String(args.trip.trip_code) : null,
          driverId,
          paymentSessionId,
          providerCaptureId,
          expectedDriverCreditPence: credit.driverNetPence,
          postedDriverCreditPence: readback.totalPence,
          failureStage: "settlement_persist",
          errorCode: parts.code,
          errorMessage: parts.message,
        });
        return postingWalletMismatch({
          settlement_status: "FAILED",
          expectedPence: credit.driverNetPence,
          postedPence: readback.totalPence,
        });
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
    const readback = await readTripEarningNetLedgerState(args.supabase, tripId);
    const reconciled = reconcileTripEarningNetLedgerReadback({
      expectedPence: expectedCredit,
      readback,
      settlementSucceeded: true,
    });
    if (reconciled.reconciliation_status === "WALLET_MISMATCH") {
      await recordWalletPostingFailureMetadata(args.supabase, {
        tripId,
        tripCode: args.trip.trip_code ? String(args.trip.trip_code) : null,
        driverId,
        paymentSessionId,
        providerCaptureId,
        expectedDriverCreditPence: expectedCredit,
        postedDriverCreditPence: readback.totalPence,
        failureStage: reconciled.failureStage ?? "wallet_readback",
        errorMessage: reconciled.failureStage ?? "wallet_readback_mismatch",
      });
    }
    return reconciled;
  } catch (err) {
    const parts = supabaseErrorParts(err);
    console.error("[applyCanonicalSettlementAfterCapture] ledger credit failed", {
      trip_id: tripId,
      error: parts.message,
    });
    const readback = await readTripEarningNetLedgerState(args.supabase, tripId).catch(() => ({
      count: 0,
      totalPence: 0,
      rows: [],
    }));
    await recordWalletPostingFailureMetadata(args.supabase, {
      tripId,
      tripCode: args.trip.trip_code ? String(args.trip.trip_code) : null,
      driverId,
      paymentSessionId,
      providerCaptureId,
      expectedDriverCreditPence: expectedCredit,
      postedDriverCreditPence: readback.totalPence,
      failureStage: "wallet_insert",
      errorCode: parts.code,
      errorMessage: parts.message,
    });
    return postingWalletMismatch({
      settlement_status: "SUCCEEDED",
      expectedPence: expectedCredit,
      postedPence: readback.totalPence,
    });
  }
}
