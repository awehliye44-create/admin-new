/**
 * Phase 0e — resume terminal/no-show wallet settlement when provider fee becomes known.
 * Idempotent: reuses postTerminalEntitlementFromSettlement; never posts gross capture.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  computeTerminalOutcomeEntitlement,
  loadTerminalCaptureEvidence,
  postTerminalEntitlementFromSettlement,
  stampTerminalOutcomeTripRow,
  TERMINAL_FEE_LEDGER_TYPE,
  type TerminalOutcomeKind,
} from "./terminalOutcomeEntitlementSSOT.ts";
import { tripBlocksDriverWalletLedgerPosting } from "./commissionWalletDeduction.ts";
import { FINANCIAL_MODEL, resolveFinancialModelStamp } from "./financialModelScopeSSOT.ts";
import { loadPaymentSession, markPaymentSessionProviderFee } from "./paymentSessionSSOT.ts";
import { resolveTerminalEntitledDriverId, resolveTerminalOutcomeKind } from "./terminalOutcomeKindSSOT.ts";
import { isUnifiedTerminalFeePolicyActive } from "./terminalFeePolicySSOT.ts";

export { resolveTerminalEntitledDriverId, resolveTerminalOutcomeKind };

export type TerminalTripRow = {
  id?: string;
  driver_id?: string | null;
  confirmed_driver_id?: string | null;
  previous_driver_id?: string | null;
  financial_model?: string | null;
  financial_outcome?: string | null;
  status?: string | null;
  payment_status?: string | null;
  payment_method?: string | null;
  currency_code?: string | null;
  no_show_charge_pence?: number | null;
  cancellation_fee_pence?: number | null;
  late_cancel_fee_pence?: number | null;
  arrival_cancellation_applied?: boolean | null;
  arrival_cancellation_reason?: string | null;
  cancelled_at?: string | null;
};

export type ResumeTerminalFeeSettlementResult = {
  resumed: boolean;
  credited: boolean;
  already_credited: boolean;
  pending: boolean;
  reason: string;
  outcome: TerminalOutcomeKind | null;
  entitlement_pence: number | null;
  stamp_status?: string | null;
};

function pence(v: unknown): number {
  const n = Math.round(Number(v ?? 0));
  return Number.isFinite(n) ? n : 0;
}

export function isTerminalFeeTrip(trip: TerminalTripRow): boolean {
  return resolveTerminalOutcomeKind(trip) != null;
}

async function ledgerTypeAlreadyPosted(
  supabase: SupabaseClient,
  tripId: string,
  ledgerType: string,
): Promise<boolean> {
  const { data } = await supabase
    .from("driver_wallet_ledger")
    .select("id")
    .eq("related_trip_id", tripId)
    .eq("type", ledgerType)
    .maybeSingle();
  return !!data?.id;
}

/**
 * Resume terminal settlement when session capture + ACTUAL provider fee are available.
 * Safe to call from webhook, backfill, admin refresh, capture persist (idempotent).
 */
export async function maybeResumeTerminalFeeSettlementAfterProviderFee(
  supabase: SupabaseClient,
  args: {
    tripId: string;
    source: string;
    providerFeePence?: number | null;
  },
): Promise<ResumeTerminalFeeSettlementResult> {
  const tripId = String(args.tripId ?? "").trim();
  if (!tripId) {
    return {
      resumed: false,
      credited: false,
      already_credited: false,
      pending: true,
      reason: "missing_trip_id",
      outcome: null,
      entitlement_pence: null,
    };
  }

  const { data: trip, error: tripErr } = await supabase
    .from("trips")
    .select(
      "id, driver_id, confirmed_driver_id, previous_driver_id, financial_model, financial_outcome, status, payment_status, payment_method, currency_code, no_show_charge_pence, cancellation_fee_pence, cancelled_at",
    )
    .eq("id", tripId)
    .maybeSingle();

  if (tripErr || !trip) {
    return {
      resumed: false,
      credited: false,
      already_credited: false,
      pending: true,
      reason: "trip_not_found",
      outcome: null,
      entitlement_pence: null,
    };
  }

  const modelStamp = resolveFinancialModelStamp(trip.financial_model);
  if (modelStamp !== FINANCIAL_MODEL.PLATFORM_COLLECTED) {
    return {
      resumed: false,
      credited: false,
      already_credited: false,
      pending: false,
      reason: "financial_model_not_platform_collected",
      outcome: null,
      entitlement_pence: null,
    };
  }

  if (await tripBlocksDriverWalletLedgerPosting(supabase, tripId)) {
    return {
      resumed: false,
      credited: false,
      already_credited: false,
      pending: false,
      reason: "financial_model_violation",
      outcome: null,
      entitlement_pence: null,
    };
  }

  const outcome = resolveTerminalOutcomeKind(trip as TerminalTripRow);
  if (!outcome) {
    return {
      resumed: false,
      credited: false,
      already_credited: false,
      pending: false,
      reason: "not_terminal_fee_trip",
      outcome: null,
      entitlement_pence: null,
    };
  }

  // #111C — prospective only: a CANCELLED_WITH_FEE decided before the unified
  // policy cutover (or with no decision instant) is never settled on the new
  // formula. Historical remediation is a separate, held workstream.
  if (
    outcome === "CANCELLED_WITH_FEE"
    && !isUnifiedTerminalFeePolicyActive(trip.cancelled_at)
  ) {
    return {
      resumed: false,
      credited: false,
      already_credited: false,
      pending: false,
      reason: "cancelled_with_fee_pre_unified_policy_cutover",
      outcome,
      entitlement_pence: null,
    };
  }

  const driverId = resolveTerminalEntitledDriverId(trip) ?? "";
  if (!driverId) {
    return {
      resumed: false,
      credited: false,
      already_credited: false,
      pending: true,
      reason: "missing_driver_id",
      outcome,
      entitlement_pence: null,
    };
  }

  const ledgerType = TERMINAL_FEE_LEDGER_TYPE;
  const alreadyPosted = await ledgerTypeAlreadyPosted(supabase, tripId, ledgerType);

  const fallbackCaptured = Math.max(
    pence(trip.no_show_charge_pence),
    pence(trip.cancellation_fee_pence),
  );
  const evidence = await loadTerminalCaptureEvidence(supabase, tripId, fallbackCaptured);

  if (evidence.captured_pence <= 0) {
    return {
      resumed: false,
      credited: false,
      already_credited: alreadyPosted,
      pending: true,
      reason: "missing_capture",
      outcome,
      entitlement_pence: null,
    };
  }

  if (!evidence.provider_fee_confirmed || evidence.provider_fee_pence == null) {
    return {
      resumed: false,
      credited: false,
      already_credited: alreadyPosted,
      pending: true,
      reason: "provider_fee_pending",
      outcome,
      entitlement_pence: null,
    };
  }

  const currency = String(trip.currency_code ?? "GBP").toUpperCase();

  // #110 P4C / #111A (MK-261126-001): never stamp before first ledger credit.
  // Stamp-before-post left durable stamp + missing TEN; completed-only sweep
  // could not heal no_show. Order: credit first (exactly-once), then stamp;
  // if stamp fails after credit, alreadyPosted path repairs stamp only.
  if (alreadyPosted) {
    const stamp = await stampTerminalOutcomeTripRow({
      supabase,
      tripId,
      outcome,
      evidence,
      paymentMethod: trip.payment_method,
    });
    console.log(
      `[terminal-fee-resume] source=${args.source} trip=${tripId} outcome=${outcome} credited=false entitlement=0p fee=${evidence.provider_fee_pence}p stamp=${stamp.stamp_status} reason=entitlement_already_posted`,
    );
    return {
      resumed: stamp.stamp_status === "STAMPED",
      credited: false,
      already_credited: true,
      pending: false,
      reason: stamp.stamp_status === "STAMPED"
        ? "stamp_repaired_after_credit"
        : "entitlement_already_posted",
      outcome,
      entitlement_pence:
        computeTerminalOutcomeEntitlement(evidence).expected_driver_entitlement_pence,
      stamp_status: stamp.stamp_status,
    };
  }

  const posted = await postTerminalEntitlementFromSettlement({
    supabase,
    tripId,
    driverId,
    outcome,
    currency,
    evidence,
  });

  if (posted.pending) {
    return {
      resumed: true,
      credited: false,
      already_credited: false,
      pending: true,
      reason: posted.pending_reason ?? "still_pending",
      outcome,
      entitlement_pence: null,
    };
  }

  const stamp = await stampTerminalOutcomeTripRow({
    supabase,
    tripId,
    outcome,
    evidence,
    paymentMethod: trip.payment_method,
  });

  const paymentStatus = String(trip.payment_status ?? "").toLowerCase();
  if (paymentStatus === "fee_pending_settlement" && posted.credited) {
    const { error: payErr } = await supabase.from("trips").update({
      payment_status: "fee_charged",
      updated_at: new Date().toISOString(),
    }).eq("id", tripId);
    if (payErr) {
      console.error("[terminal-fee-resume] PAYMENT_STATUS_UPDATE_FAILED", JSON.stringify({
        trip_id: tripId,
        error: payErr.message ?? String(payErr),
      }));
    }
  }

  console.log(
    `[terminal-fee-resume] source=${args.source} trip=${tripId} outcome=${outcome} credited=${posted.credited} entitlement=${posted.entitlement_pence ?? 0}p fee=${evidence.provider_fee_pence}p stamp=${stamp.stamp_status}`,
  );

  return {
    resumed: true,
    credited: posted.credited,
    already_credited: posted.credited && posted.pending === false && posted.entitlement_pence != null,
    pending: false,
    reason: posted.credited ? "credited" : "zero_entitlement",
    outcome,
    entitlement_pence: posted.entitlement_pence,
    stamp_status: stamp.stamp_status,
  };
}

/** Persist fee on session (+ trip mirror) then attempt terminal resume. */
export async function persistProviderFeeAndMaybeResumeTerminalSettlement(
  supabase: SupabaseClient,
  args: {
    sessionId?: string | null;
    clientActionId?: string | null;
    providerOrderId?: string | null;
    tripId?: string | null;
    providerFeePence: number | null;
    retrieveSucceeded?: boolean;
    source: string;
  },
): Promise<{ fee_persisted: boolean; resume: ResumeTerminalFeeSettlementResult | null }> {
  if (args.providerFeePence == null || !Number.isFinite(Number(args.providerFeePence))) {
    return { fee_persisted: false, resume: null };
  }

  const fee = Math.max(0, Math.round(Number(args.providerFeePence)));
  await markPaymentSessionProviderFee(supabase, {
    sessionId: args.sessionId,
    clientActionId: args.clientActionId,
    providerOrderId: args.providerOrderId,
    providerFeePence: fee,
    retrieveSucceeded: args.retrieveSucceeded ?? true,
  });

  let tripId = args.tripId ? String(args.tripId) : "";
  if (!tripId) {
    const session = await loadPaymentSession(supabase, {
      sessionId: args.sessionId,
      clientActionId: args.clientActionId,
      providerOrderId: args.providerOrderId,
    });
    tripId = session?.trip_id != null ? String(session.trip_id) : "";
  }

  if (tripId) {
    await supabase.from("trips").update({
      provider_fee_pence: fee,
      updated_at: new Date().toISOString(),
    }).eq("id", tripId);
  }

  const resume = tripId
    ? await maybeResumeTerminalFeeSettlementAfterProviderFee(supabase, {
      tripId,
      source: args.source,
      providerFeePence: fee,
    })
    : null;

  return { fee_persisted: true, resume };
}
