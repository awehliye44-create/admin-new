/**
 * Phase 7 — call convert_driver_commission_wallet_on_trip_complete.
 * No-ops when CW gate off. Never writes driver_wallet_ledger.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import { tripUsesCommissionWalletDeduction } from "../../../shared/commissionWalletSSOT.ts";
import { calculateTripSettlement } from "./tripSettlement.ts";

export type ConvertCommissionWalletOnCompleteResult = {
  ok: boolean;
  skipped?: boolean;
  idempotent?: boolean;
  code?: string;
  error?: string;
  amount_minor?: number;
  commission_earned_minor?: number;
  shortfall_minor?: number;
  revenue_source?: string;
  ledger_entry_id?: string;
  raw: Record<string, unknown>;
};

export async function convertCommissionWalletOnTripComplete(input: {
  supabase: SupabaseClient;
  driverId: string;
  tripId: string;
  commissionMinor: number;
  commissionableFareMinor?: number;
  commissionRateBps?: number;
}): Promise<ConvertCommissionWalletOnCompleteResult> {
  const { data, error } = await input.supabase.rpc(
    "convert_driver_commission_wallet_on_trip_complete",
    {
      p_driver_id: input.driverId,
      p_trip_id: input.tripId,
      p_commission_minor: Math.max(0, Math.round(Number(input.commissionMinor) || 0)),
      p_commissionable_fare_minor:
        input.commissionableFareMinor != null
          ? Math.max(0, Math.round(Number(input.commissionableFareMinor) || 0))
          : null,
      p_commission_rate_bps:
        input.commissionRateBps != null
          ? Math.max(0, Math.round(Number(input.commissionRateBps) || 0))
          : null,
    },
  );

  if (error) {
    console.error("[commissionWalletDeduction] RPC failed", {
      trip_id: input.tripId,
      driver_id: input.driverId,
      error: error.message,
    });
    return {
      ok: false,
      code: "RPC_FAILED",
      error: error.message,
      raw: { error: error.message },
    };
  }

  const raw = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const ok = raw.ok === true || raw.ok === "true";
  return {
    ok,
    skipped: raw.skipped === true || raw.skipped === "true",
    idempotent: raw.idempotent === true || raw.idempotent === "true",
    code: raw.code != null ? String(raw.code) : undefined,
    error: raw.error != null ? String(raw.error) : undefined,
    amount_minor: raw.amount_minor != null ? Number(raw.amount_minor) : undefined,
    commission_earned_minor:
      raw.commission_earned_minor != null ? Number(raw.commission_earned_minor) : undefined,
    shortfall_minor: raw.shortfall_minor != null ? Number(raw.shortfall_minor) : undefined,
    revenue_source: raw.revenue_source != null ? String(raw.revenue_source) : undefined,
    ledger_entry_id: raw.ledger_entry_id != null ? String(raw.ledger_entry_id) : undefined,
    raw,
  };
}

/** True when this trip must never post to driver_wallet_ledger. */
export async function tripBlocksDriverWalletLedgerPosting(
  supabase: SupabaseClient,
  tripId: string,
): Promise<boolean> {
  const { data: trip } = await supabase
    .from("trips")
    .select("financial_model, commission_wallet_enabled, service_area_id")
    .eq("id", tripId)
    .maybeSingle();
  if (!trip) return false;

  if (trip.financial_model != null && trip.commission_wallet_enabled != null) {
    return tripUsesCommissionWalletDeduction({
      tripFinancialModel: trip.financial_model as string,
      tripCommissionWalletEnabled: trip.commission_wallet_enabled as boolean,
    });
  }
  if (!trip.service_area_id) return false;

  const { data: sa } = await supabase
    .from("service_areas")
    .select("financial_model, commission_wallet_enabled")
    .eq("id", trip.service_area_id)
    .maybeSingle();

  return tripUsesCommissionWalletDeduction({
    serviceAreaConfig: sa
      ? {
        financial_model: sa.financial_model,
        commission_wallet_enabled: sa.commission_wallet_enabled,
      }
      : null,
  });
}

/**
 * Idempotent repair: if trip is CW-gated and missing COMMISSION_DEDUCTION, run convert.
 * Safe to call on already-completed trips (status-only complete failure recovery).
 */
export async function ensureCommissionWalletDeductionForCompletedTrip(input: {
  supabase: SupabaseClient;
  tripId: string;
  driverId?: string | null;
}): Promise<ConvertCommissionWalletOnCompleteResult & { repaired?: boolean }> {
  const { data: trip, error: tripErr } = await input.supabase
    .from("trips")
    .select(
      "id, driver_id, service_area_id, financial_model, commission_wallet_enabled, final_fare_pence, final_customer_fare_pence, airport_charge_pence, other_pass_through_charges_pence, tip_amount_pence, tip_pence, driver_tier_commission_percent, commission_pence, commissionable_fare_pence, snapshotted_commission_rate_bps",
    )
    .eq("id", input.tripId)
    .maybeSingle();

  if (tripErr || !trip) {
    return {
      ok: false,
      code: "TRIP_NOT_FOUND",
      error: tripErr?.message ?? "Trip not found",
      raw: {},
    };
  }

  const driverId = String(input.driverId ?? trip.driver_id ?? "").trim();
  if (!driverId) {
    return { ok: true, skipped: true, code: "NO_DRIVER", raw: { skipped: true } };
  }

  let saConfig: { financial_model: unknown; commission_wallet_enabled: unknown } | null = null;
  if (trip.service_area_id) {
    const { data: sa } = await input.supabase
      .from("service_areas")
      .select("financial_model, commission_wallet_enabled")
      .eq("id", trip.service_area_id)
      .maybeSingle();
    saConfig = sa;
  }

  const usesCw = tripUsesCommissionWalletDeduction({
    tripFinancialModel: trip.financial_model as string | null,
    tripCommissionWalletEnabled: trip.commission_wallet_enabled as boolean | null,
    serviceAreaConfig: saConfig
      ? {
        financial_model: saConfig.financial_model as string,
        commission_wallet_enabled: saConfig.commission_wallet_enabled as boolean,
      }
      : null,
  });

  if (!usesCw) {
    return { ok: true, skipped: true, code: "WALLET_GATE_OFF", raw: { skipped: true } };
  }

  const { data: existing } = await input.supabase
    .from("driver_commission_wallet_ledger")
    .select("id, amount_minor")
    .eq("trip_id", input.tripId)
    .eq("entry_type", "COMMISSION_DEDUCTION")
    .maybeSingle();

  if (existing?.id) {
    return {
      ok: true,
      idempotent: true,
      skipped: true,
      code: "ALREADY_DEDUCTED",
      ledger_entry_id: String(existing.id),
      amount_minor: Number(existing.amount_minor) || 0,
      revenue_source: "COMMISSION_WALLET_DEDUCTION",
      raw: { ok: true, idempotent: true, code: "ALREADY_DEDUCTED" },
    };
  }

  const farePence = Math.max(
    0,
    Number(trip.final_customer_fare_pence)
      || Number(trip.final_fare_pence)
      || 0,
  );
  const settlement = calculateTripSettlement({
    final_fare_pence: farePence,
    airport_charge_pence: Number(trip.airport_charge_pence ?? 0),
    other_pass_through_charges_pence: Number(trip.other_pass_through_charges_pence ?? 0),
    tips_pence: Number(trip.tip_amount_pence ?? trip.tip_pence ?? 0),
    driver_tier_commission_percent: Number(trip.driver_tier_commission_percent ?? 0),
  });
  const commissionMinor = Math.max(
    0,
    Number(trip.commission_pence) || settlement.commission_pence,
  );
  const commissionable = Math.max(
    0,
    Number(trip.commissionable_fare_pence) || settlement.commissionable_fare_pence,
  );
  const rateBps = Math.max(
    0,
    Number(trip.snapshotted_commission_rate_bps)
      || Math.round(settlement.tier_percent_used * 100),
  );

  const result = await convertCommissionWalletOnTripComplete({
    supabase: input.supabase,
    driverId,
    tripId: input.tripId,
    commissionMinor,
    commissionableFareMinor: commissionable,
    commissionRateBps: rateBps,
  });

  return { ...result, repaired: result.ok && !result.idempotent && !result.skipped };
}
