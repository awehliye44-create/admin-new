/**
 * Phase 0 — canonical typed wallet posting paths.
 * TRIP_EARNING_NET authority lives in creditCapturedCardTripLedger (onecabFinanceLedger.ts).
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { creditCapturedCardTripLedger } from "./onecabFinanceLedger.ts";
import { type TripSettlementTripRow } from "./tripSettlement.ts";
import {
  loadTerminalCaptureEvidence,
  postTerminalEntitlementFromSettlement,
  stampTerminalOutcomeTripRow,
} from "./terminalOutcomeEntitlementSSOT.ts";

export type PostTripEarningNetArgs = {
  driverId: string;
  tripId: string;
  driverNetPence: number;
  tipPence?: number;
  currency?: string;
  commissionPct?: number;
  paymentId?: string | null;
};

/** Canonical TRIP_EARNING_NET (+ optional tip) posting. */
export async function postTripEarningNetCanonical(
  supabase: SupabaseClient,
  args: PostTripEarningNetArgs,
): Promise<{ credited: boolean; recovery_pence: number }> {
  return creditCapturedCardTripLedger(supabase, {
    driverId: args.driverId,
    tripId: args.tripId,
    driverNetPence: Math.max(0, Math.round(Number(args.driverNetPence) || 0)),
    tipPence: Math.max(0, Math.round(Number(args.tipPence) || 0)),
    currency: args.currency ?? "GBP",
    paymentId: args.paymentId ?? null,
    commissionPct: args.commissionPct,
  });
}

/** Completed card trip from stamped settlement columns. */
export async function postStampedTripSettlementWalletCredit(
  supabase: SupabaseClient,
  args: {
    trip: TripSettlementTripRow & { driver_id: string; id: string };
    currency?: string;
    paymentId?: string | null;
  },
): Promise<{ credited: boolean; recovery_pence: number }> {
  const driverNet = Math.max(
    0,
    Math.round(Number(args.trip.driver_net_pence) || 0)
      + Math.round(Number(args.trip.airport_charge_pence) || 0),
  );
  const tipPence = Math.max(
    0,
    Math.round(Number(args.trip.tip_pence ?? args.trip.tip_amount_pence) || 0),
  );
  const pctRaw = Number(args.trip.accepted_commission_percent ?? args.trip.commission_pct);
  return postTripEarningNetCanonical(supabase, {
    driverId: String(args.trip.driver_id),
    tripId: String(args.trip.id),
    driverNetPence: driverNet,
    tipPence,
    currency: args.currency,
    paymentId: args.paymentId,
    commissionPct: Number.isFinite(pctRaw) ? pctRaw : undefined,
  });
}

/** Terminal fee outcomes — canonical settlement → entitlement posting only. */
export async function postTerminalOutcomeSettlement(args: {
  supabase: SupabaseClient;
  tripId: string;
  driverId: string;
  serviceAreaId: string | null;
  feePence: number;
  outcome: "NO_SHOW" | "LATE_PASSENGER_CANCELLATION";
  paymentMethod?: string | null;
  currencyCode: string;
}): Promise<{
  commission_pct: number;
  commission_pence: number;
  driver_net_pence: number;
  credited: boolean;
  pending: boolean;
}> {
  void args.serviceAreaId;
  const evidence = await loadTerminalCaptureEvidence(
    args.supabase,
    args.tripId,
    Math.max(0, Math.round(Number(args.feePence) || 0)),
  );

  await stampTerminalOutcomeTripRow({
    supabase: args.supabase,
    tripId: args.tripId,
    outcome: args.outcome,
    evidence,
    paymentMethod: args.paymentMethod,
  });

  const posted = await postTerminalEntitlementFromSettlement({
    supabase: args.supabase,
    tripId: args.tripId,
    driverId: args.driverId,
    outcome: args.outcome,
    currency: args.currencyCode,
    evidence,
  });

  return {
    commission_pct: 0,
    commission_pence: posted.commission_pence,
    driver_net_pence: posted.entitlement_pence ?? 0,
    credited: posted.credited,
    pending: posted.pending,
  };
}

/** @deprecated Use postTerminalEntitlementFromSettlement via settleNoShowFee. */
export async function postNoShowDriverCompensation(
  supabase: SupabaseClient,
  input: {
    driverId: string;
    tripId: string;
    feePence: number;
    currency: string;
  },
): Promise<boolean> {
  const evidence = await loadTerminalCaptureEvidence(
    supabase,
    input.tripId,
    Math.max(0, Math.round(Number(input.feePence) || 0)),
  );
  const posted = await postTerminalEntitlementFromSettlement({
    supabase,
    tripId: input.tripId,
    driverId: input.driverId,
    outcome: "NO_SHOW",
    currency: input.currency,
    evidence,
  });
  return posted.credited;
}

/** Repair/backfill missing TRIP_EARNING_NET via canonical poster only. */
export async function repairMissingTripEarningNet(
  supabase: SupabaseClient,
  args: PostTripEarningNetArgs,
): Promise<{ credited: boolean; recovery_pence: number }> {
  return postTripEarningNetCanonical(supabase, args);
}
