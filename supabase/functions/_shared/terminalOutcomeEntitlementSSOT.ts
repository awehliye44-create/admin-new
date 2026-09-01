/**
 * Terminal outcome entitlement — canonical settlement → wallet posting.
 * Wallet amount is never calculated independently in noShowSettlement or callers.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { computeAuthoritativeSettlement } from "../../../shared/canonicalSettlementSSOT.ts";
import { resolveTerminalFeeDriverTenPence } from "./frDriverExpectedEntitlementSSOT.ts";
import { hasConflictingEntitlementTypes } from "./driverEntitlementLedgerSSOT.ts";
import { tripSettlementDbColumns } from "./tripSettlement.ts";

export type TerminalOutcomeKind = "NO_SHOW" | "LATE_PASSENGER_CANCELLATION";

export type TerminalCaptureEvidence = {
  payment_session_id: string | null;
  captured_pence: number;
  provider_fee_pence: number | null;
  provider_fee_confirmed: boolean;
};

export type TerminalEntitlementResult = {
  captured_pence: number;
  provider_fee_pence: number | null;
  commission_pence: number;
  expected_driver_entitlement_pence: number | null;
  pending: boolean;
  pending_reason: string | null;
  formula_version: string;
};

export function computeTerminalOutcomeEntitlement(
  evidence: TerminalCaptureEvidence,
): TerminalEntitlementResult {
  const captured = Math.max(0, Math.round(Number(evidence.captured_pence)));
  const feeConfirmed = evidence.provider_fee_confirmed === true
    && evidence.provider_fee_pence != null
    && Number.isFinite(Number(evidence.provider_fee_pence))
    && Number(evidence.provider_fee_pence) >= 0;

  if (captured <= 0) {
    return {
      captured_pence: 0,
      provider_fee_pence: null,
      commission_pence: 0,
      expected_driver_entitlement_pence: null,
      pending: true,
      pending_reason: "missing_capture",
      formula_version: "2",
    };
  }

  if (!feeConfirmed) {
    return {
      captured_pence: captured,
      provider_fee_pence: evidence.provider_fee_pence,
      commission_pence: 0,
      expected_driver_entitlement_pence: null,
      pending: true,
      pending_reason: "provider_fee_pending",
      formula_version: "2",
    };
  }

  const providerFee = Math.max(0, Math.round(Number(evidence.provider_fee_pence)));
  const settlement = computeAuthoritativeSettlement({
    ride_fare_pence: captured,
    commission_percent: 0,
    provider_processing_fee_pence: providerFee,
    fee_confirmed: true,
    financial_outcome: "TERMINAL_FEE",
    capture_identity_pence: captured,
  });

  const entitlement = resolveTerminalFeeDriverTenPence({
    captured_pence: captured,
    provider_fee_pence: providerFee,
    commission_pence: 0,
  });

  return {
    captured_pence: captured,
    provider_fee_pence: providerFee,
    commission_pence: settlement.commission_amount_pence,
    expected_driver_entitlement_pence: entitlement,
    pending: false,
    pending_reason: null,
    formula_version: settlement.formula_version,
  };
}

export async function loadTerminalCaptureEvidence(
  supabase: SupabaseClient,
  tripId: string,
  fallbackCapturedPence?: number | null,
): Promise<TerminalCaptureEvidence> {
  const { data: ps } = await supabase
    .from("payment_sessions")
    .select("id, captured_amount_pence, provider_processing_fee_pence, fee_status, status")
    .eq("trip_id", tripId)
    .order("captured_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const captured = ps?.captured_amount_pence != null
    ? Math.round(Number(ps.captured_amount_pence))
    : Math.max(0, Math.round(Number(fallbackCapturedPence ?? 0)));

  const feeStatus = String(ps?.fee_status ?? "").toUpperCase();
  const feeRaw = ps?.provider_processing_fee_pence;
  const feeConfirmed = feeStatus === "ACTUAL"
    && feeRaw != null
    && Number.isFinite(Number(feeRaw));

  return {
    payment_session_id: ps?.id != null ? String(ps.id) : null,
    captured_pence: captured,
    provider_fee_pence: feeConfirmed ? Math.round(Number(feeRaw)) : null,
    provider_fee_confirmed: feeConfirmed,
  };
}

async function existingEntitlementTypes(
  supabase: SupabaseClient,
  tripId: string,
): Promise<string[]> {
  const { data } = await supabase
    .from("driver_wallet_ledger")
    .select("type")
    .eq("related_trip_id", tripId)
    .in("type", ["TRIP_EARNING_NET", "DRIVER_COMPENSATION_CREDIT"]);
  return (data ?? []).map((r) => String(r.type));
}

async function ledgerEntryExists(
  supabase: SupabaseClient,
  tripId: string,
  type: string,
): Promise<boolean> {
  const { data } = await supabase
    .from("driver_wallet_ledger")
    .select("id")
    .eq("related_trip_id", tripId)
    .eq("type", type)
    .maybeSingle();
  return !!data?.id;
}

export type PostTerminalEntitlementResult = {
  credited: boolean;
  pending: boolean;
  pending_reason: string | null;
  entitlement_pence: number | null;
  ledger_type: string | null;
  commission_pence: number;
};

/** Canonical terminal wallet posting — idempotent, conflict-safe. */
export async function postTerminalEntitlementFromSettlement(args: {
  supabase: SupabaseClient;
  tripId: string;
  driverId: string;
  outcome: TerminalOutcomeKind;
  currency: string;
  evidence: TerminalCaptureEvidence;
}): Promise<PostTerminalEntitlementResult> {
  const entitlement = computeTerminalOutcomeEntitlement(args.evidence);

  if (entitlement.pending || entitlement.expected_driver_entitlement_pence == null) {
    return {
      credited: false,
      pending: true,
      pending_reason: entitlement.pending_reason,
      entitlement_pence: null,
      ledger_type: null,
      commission_pence: 0,
    };
  }

  const amount = entitlement.expected_driver_entitlement_pence;
  if (amount <= 0) {
    return {
      credited: false,
      pending: false,
      pending_reason: null,
      entitlement_pence: 0,
      ledger_type: null,
      commission_pence: 0,
    };
  }

  const ledgerType = args.outcome === "NO_SHOW"
    ? "DRIVER_COMPENSATION_CREDIT"
    : "TRIP_EARNING_NET";

  const existingTypes = await existingEntitlementTypes(args.supabase, args.tripId);
  const proposed = [...existingTypes, ledgerType];
  if (hasConflictingEntitlementTypes(proposed)) {
    throw new Error("TERMINAL_ENTITLEMENT_CONFLICT: TRIP_EARNING_NET and DRIVER_COMPENSATION_CREDIT");
  }

  if (await ledgerEntryExists(args.supabase, args.tripId, ledgerType)) {
    return {
      credited: true,
      pending: false,
      pending_reason: null,
      entitlement_pence: amount,
      ledger_type: ledgerType,
      commission_pence: entitlement.commission_pence,
    };
  }

  const cs = args.currency.toUpperCase();
  const major = (amount / 100).toFixed(2);

  const { error } = await args.supabase.from("driver_wallet_ledger").insert({
    driver_id: args.driverId,
    related_trip_id: args.tripId,
    type: ledgerType,
    amount_pence: amount,
    currency: cs,
    description: args.outcome === "NO_SHOW"
      ? `No-show compensation (ONECAB) — ${cs} ${major}`
      : `Charged cancellation compensation — ${cs} ${major}`,
  });
  if (error && error.code !== "23505") throw error;

  if (args.outcome === "NO_SHOW" && !(await ledgerEntryExists(args.supabase, args.tripId, "NO_SHOW_FEE"))) {
    await args.supabase.from("driver_wallet_ledger").insert({
      driver_id: args.driverId,
      related_trip_id: args.tripId,
      type: "NO_SHOW_FEE",
      amount_pence: entitlement.captured_pence,
      currency: cs,
      description: `No-show fee — ${cs} ${(entitlement.captured_pence / 100).toFixed(2)}`,
    }).then(({ error: feeErr }) => {
      if (feeErr && feeErr.code !== "23505") throw feeErr;
    });
  }

  return {
    credited: true,
    pending: false,
    pending_reason: null,
    entitlement_pence: amount,
    ledger_type: ledgerType,
    commission_pence: entitlement.commission_pence,
  };
}

export async function stampTerminalOutcomeTripRow(args: {
  supabase: SupabaseClient;
  tripId: string;
  outcome: TerminalOutcomeKind;
  evidence: TerminalCaptureEvidence;
  paymentMethod?: string | null;
}): Promise<TerminalEntitlementResult> {
  const entitlement = computeTerminalOutcomeEntitlement(args.evidence);
  const tripStatusMap: Record<TerminalOutcomeKind, string> = {
    NO_SHOW: "no_show",
    LATE_PASSENGER_CANCELLATION: "cancelled",
  };

  const settlement = computeAuthoritativeSettlement({
    ride_fare_pence: entitlement.captured_pence,
    commission_percent: 0,
    provider_processing_fee_pence: entitlement.provider_fee_pence,
    fee_confirmed: entitlement.provider_fee_confirmed,
    financial_outcome: args.outcome,
    capture_identity_pence: entitlement.captured_pence,
  });

  await args.supabase.from("trips").update({
    status: tripStatusMap[args.outcome],
    financial_outcome: args.outcome,
    gross_fare_pence: entitlement.captured_pence,
    capture_amount_pence: entitlement.captured_pence,
    commission_pence: 0,
    commission_pct: 0,
    driver_net_pence: entitlement.expected_driver_entitlement_pence ?? 0,
    provider_fee_pence: entitlement.provider_fee_pence,
    payment_method: args.paymentMethod ?? undefined,
    completed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...tripSettlementDbColumns({
      final_fare_pence: entitlement.captured_pence,
      commissionable_fare_pence: entitlement.captured_pence,
      commission_pence: 0,
      locked_promotion_pence: 0,
      applied_customer_promotion_pence: 0,
      commission_after_promotion_pence: 0,
      driver_net_pence: entitlement.expected_driver_entitlement_pence ?? 0,
      driver_total_earnings_pence: entitlement.expected_driver_entitlement_pence ?? 0,
      airport_charge_pence: 0,
      other_pass_through_charges_pence: 0,
      tips_pence: 0,
      provider_fee_pence: entitlement.provider_fee_pence ?? 0,
      provider_fee_confirmed: entitlement.provider_fee_confirmed,
      platform_gross_revenue_pence: 0,
      platform_net_revenue_pence: settlement.onecab_net_commission_pence ?? 0,
      onecab_net_pence: settlement.onecab_net_commission_pence,
      tier_percent_used: 0,
      formula_version: settlement.formula_version,
    }),
  }).eq("id", args.tripId);

  return entitlement;
}
