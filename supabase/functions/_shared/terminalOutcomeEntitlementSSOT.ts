/**
 * Terminal outcome entitlement — canonical settlement → wallet posting.
 * Wallet amount is never calculated independently in noShowSettlement or callers.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import { computeAuthoritativeSettlement } from "./canonicalSettlementSSOT.ts";
import { resolveTerminalFeeDriverTenPence } from "./frDriverExpectedEntitlementSSOT.ts";
import { hasConflictingEntitlementTypes } from "./driverEntitlementLedgerSSOT.ts";
import { tripSettlementDbColumns } from "./tripSettlement.ts";
import type { TerminalOutcomeKind } from "./terminalOutcomeKindSSOT.ts";

export type { TerminalOutcomeKind };

/** One ledger type for every chargeable terminal fee. Idempotent per trip. */
export const TERMINAL_FEE_LEDGER_TYPE = "TRIP_EARNING_NET";

export type TerminalCaptureEvidence = {
  payment_session_id: string | null;
  captured_pence: number;
  provider_fee_pence: number | null;
  provider_fee_confirmed: boolean;
};

export type TerminalEntitlementResult = {
  captured_pence: number;
  provider_fee_pence: number | null;
  provider_fee_confirmed: boolean;
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
      provider_fee_confirmed: false,
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
      provider_fee_confirmed: false,
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
    provider_fee_confirmed: true,
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

  const ledgerType = TERMINAL_FEE_LEDGER_TYPE;

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
  const description = args.outcome === "NO_SHOW"
    ? `No-show compensation (ONECAB) — ${cs} ${major}`
    : args.outcome === "ARRIVAL_CANCELLATION"
      ? `Arrival cancellation compensation — ${cs} ${major}`
      : `Late passenger cancellation compensation — ${cs} ${major}`;

  const { error } = await args.supabase.from("driver_wallet_ledger").insert({
    driver_id: args.driverId,
    related_trip_id: args.tripId,
    type: ledgerType,
    amount_pence: amount,
    currency: cs,
    description,
  });
  if (error && error.code !== "23505") throw error;

  return {
    credited: true,
    pending: false,
    pending_reason: null,
    entitlement_pence: amount,
    ledger_type: ledgerType,
    commission_pence: entitlement.commission_pence,
  };
}

export type TerminalTripStampStatus =
  | "STAMPED"
  | "SKIPPED_PROVIDER_FEE_PENDING"
  | "STAMP_UPDATE_FAILED"
  | "STAMP_READBACK_MISMATCH";

export type TerminalTripStampResult = TerminalEntitlementResult & {
  stamp_status: TerminalTripStampStatus;
  stamp_error: string | null;
};

export const TERMINAL_TRIP_STAMP_FAILED_EVENT = "TERMINAL_TRIP_STAMP_FAILED";

const TERMINAL_TRIP_STATUS: Record<TerminalOutcomeKind, string> = {
  NO_SHOW: "no_show",
  LATE_PASSENGER_CANCELLATION: "cancelled",
  ARRIVAL_CANCELLATION: "cancelled",
};

/**
 * Trip-row projection of the terminal settlement:
 *   capture − terminal commission (0) − ACTUAL provider fee = driver terminal net.
 * A chargeable cancellation is not a completed ride: completed_at is never written.
 */
export function buildTerminalOutcomeTripPatch(args: {
  outcome: TerminalOutcomeKind;
  entitlement: TerminalEntitlementResult;
  paymentMethod?: string | null;
  nowIso: string;
}): Record<string, unknown> | null {
  const { entitlement } = args;
  if (
    entitlement.pending
    || !entitlement.provider_fee_confirmed
    || entitlement.provider_fee_pence == null
    || entitlement.expected_driver_entitlement_pence == null
  ) {
    return null;
  }
  const captured = entitlement.captured_pence;
  const fee = entitlement.provider_fee_pence;
  const net = entitlement.expected_driver_entitlement_pence;
  const settlement = computeAuthoritativeSettlement({
    ride_fare_pence: captured,
    commission_percent: 0,
    provider_processing_fee_pence: fee,
    fee_confirmed: true,
    financial_outcome: args.outcome,
    capture_identity_pence: captured,
  });
  return {
    status: TERMINAL_TRIP_STATUS[args.outcome],
    financial_outcome: args.outcome,
    capture_amount_pence: captured,
    commission_pct: 0,
    payment_method: args.paymentMethod ?? undefined,
    updated_at: args.nowIso,
    ...tripSettlementDbColumns({
      final_fare_pence: captured,
      commissionable_fare_pence: captured,
      commission_pence: 0,
      locked_promotion_pence: 0,
      applied_customer_promotion_pence: 0,
      commission_after_promotion_pence: 0,
      driver_net_pence: net,
      driver_total_earnings_pence: net,
      airport_charge_pence: 0,
      other_pass_through_charges_pence: 0,
      tips_pence: 0,
      provider_fee_pence: fee,
      provider_fee_confirmed: true,
      platform_gross_revenue_pence: 0,
      platform_net_revenue_pence: settlement.onecab_net_commission_pence ?? 0,
      onecab_net_pence: settlement.onecab_net_commission_pence,
      tier_percent_used: 0,
      formula_version: settlement.formula_version,
    }),
  };
}

async function auditTerminalStampFailure(
  supabase: SupabaseClient,
  args: {
    tripId: string;
    outcome: TerminalOutcomeKind;
    status: TerminalTripStampStatus;
    error: string;
    entitlement: TerminalEntitlementResult;
  },
): Promise<void> {
  console.error(`[terminal-stamp] ${TERMINAL_TRIP_STAMP_FAILED_EVENT}`, JSON.stringify({
    trip_id: args.tripId,
    outcome: args.outcome,
    stamp_status: args.status,
    error: args.error,
    captured_pence: args.entitlement.captured_pence,
    provider_fee_pence: args.entitlement.provider_fee_pence,
    expected_driver_entitlement_pence: args.entitlement.expected_driver_entitlement_pence,
  }));
  try {
    const { error } = await supabase.from("ops_events").insert({
      event_type: TERMINAL_TRIP_STAMP_FAILED_EVENT,
      category: "financial",
      severity: "error",
      app: "backend",
      trip_id: args.tripId,
      amount_pence: args.entitlement.expected_driver_entitlement_pence,
      currency_code: "GBP",
      description: `Terminal trip stamp ${args.status} for ${args.outcome}`,
      metadata: {
        outcome: args.outcome,
        stamp_status: args.status,
        error: args.error,
        captured_pence: args.entitlement.captured_pence,
        provider_fee_pence: args.entitlement.provider_fee_pence,
        expected_driver_entitlement_pence: args.entitlement.expected_driver_entitlement_pence,
        ledger_is_ssot: true,
      },
    });
    if (error) console.error("[terminal-stamp] audit insert failed", error.message);
  } catch (err) {
    console.error("[terminal-stamp] audit insert threw", err instanceof Error ? err.message : String(err));
  }
}

/**
 * Stamps the trip row with the terminal settlement. Never throws: the
 * TRIP_EARNING_NET ledger row is the entitlement SSOT and must not be rolled
 * back or duplicated because the trip projection failed. Failures are logged
 * and written to ops_events, and reported in stamp_status.
 */
export async function stampTerminalOutcomeTripRow(args: {
  supabase: SupabaseClient;
  tripId: string;
  outcome: TerminalOutcomeKind;
  evidence: TerminalCaptureEvidence;
  paymentMethod?: string | null;
}): Promise<TerminalTripStampResult> {
  const entitlement = computeTerminalOutcomeEntitlement(args.evidence);
  const patch = buildTerminalOutcomeTripPatch({
    outcome: args.outcome,
    entitlement,
    paymentMethod: args.paymentMethod,
    nowIso: new Date().toISOString(),
  });
  if (!patch) {
    return { ...entitlement, stamp_status: "SKIPPED_PROVIDER_FEE_PENDING", stamp_error: null };
  }

  const { error } = await args.supabase.from("trips").update(patch).eq("id", args.tripId);
  if (error) {
    const message = `${(error as { code?: string }).code ?? "error"}:${error.message ?? "update_failed"}`;
    await auditTerminalStampFailure(args.supabase, {
      tripId: args.tripId,
      outcome: args.outcome,
      status: "STAMP_UPDATE_FAILED",
      error: message,
      entitlement,
    });
    return { ...entitlement, stamp_status: "STAMP_UPDATE_FAILED", stamp_error: message };
  }

  const { data: after, error: readErr } = await args.supabase
    .from("trips")
    .select("driver_net_pence, gross_fare_pence, commission_pence, provider_fee_pence, financial_outcome")
    .eq("id", args.tripId)
    .maybeSingle();
  const row = after as Record<string, unknown> | null;
  const matches = !readErr
    && row != null
    && Number(row.driver_net_pence) === entitlement.expected_driver_entitlement_pence
    && Number(row.gross_fare_pence) === entitlement.captured_pence
    && Number(row.commission_pence) === 0
    && Number(row.provider_fee_pence) === entitlement.provider_fee_pence
    && String(row.financial_outcome ?? "").toUpperCase() === args.outcome;
  if (!matches) {
    const message = readErr
      ? `readback_failed:${readErr.message}`
      : `readback_mismatch:${JSON.stringify(row)}`;
    await auditTerminalStampFailure(args.supabase, {
      tripId: args.tripId,
      outcome: args.outcome,
      status: "STAMP_READBACK_MISMATCH",
      error: message,
      entitlement,
    });
    return { ...entitlement, stamp_status: "STAMP_READBACK_MISMATCH", stamp_error: message };
  }

  return { ...entitlement, stamp_status: "STAMPED", stamp_error: null };
}
