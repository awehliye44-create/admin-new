/**
 * Historical settlement-correction plan builder.
 *
 * Purpose:
 * - Build a dry-run, explicit-UUID correction plan for trips whose saved settlement
 *   stamps are defective (e.g. MK-260817-007 / MK-260817-009).
 *
 * Hard rules:
 * - Never calls Revolut or any payment provider.
 * - Never captures, refunds, or releases money.
 * - Never processes a cohort or date range.
 * - Explicit UUID allow-list only.
 * - Default dry-run only.
 * - Does not write by default; returns proposed compare-and-set patch + audit payload.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import { classifyFrPromotionApplication } from "./frPerTripAuditSSOT.ts";
import {
  calculateTripSettlementFromTripRow,
  tripSettlementDbColumns,
  tripSettlementSnapshotJson,
  type TripSettlementTripRow,
} from "./tripSettlement.ts";

export type HistoricalSettlementCorrectionPlanResult =
  | { status: "NOT_IN_ALLOW_LIST"; tripId: string; dryRun: boolean }
  | { status: "TRIP_NOT_FOUND"; tripId: string; dryRun: boolean }
  | { status: "NO_CORRECTION_REQUIRED"; tripId: string; tripCode: string | null; dryRun: boolean }
  | {
    status: "PENDING_EVIDENCE";
    tripId: string;
    tripCode: string | null;
    dryRun: boolean;
    reason: string;
  }
  | {
    status: "CORRECTION_REQUIRED_DRY_RUN";
    tripId: string;
    tripCode: string | null;
    dryRun: true;
    captured_amount_pence: number | null;
    saved: {
      commissionable_fare_pence: number | null;
      commission_pence: number | null;
      driver_net_pence: number | null;
    };
    corrected: {
      commissionable_fare_pence: number;
      commission_pence: number;
      driver_net_pence: number;
      applied_customer_promotion_pence: number;
      commission_after_promotion_pence: number;
      capture_amount_pence: number | null;
    };
    compare_and_set: {
      id: string;
      current_commissionable_fare_pence: number | null;
      current_commission_pence: number | null;
      current_driver_net_pence: number | null;
      current_capture_amount_pence: number | null;
      current_settlement_formula_version: string | null;
    };
    proposed_trip_patch: Record<string, number | string | null>;
    proposed_snapshot_patch: Record<string, number | string | null>;
    audit_reason: string;
  }
  | {
    status: "EXECUTION_DISABLED";
    tripId: string;
    tripCode: string | null;
    dryRun: false;
    reason: string;
  };

function safePence(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.round(n));
}

function commissionRatePresent(trip: Record<string, unknown>): boolean {
  const pct = trip.accepted_commission_percent ?? trip.commission_pct ?? trip.driver_tier_commission_percent;
  if (pct == null) return false;
  const n = Number(pct);
  return Number.isFinite(n) && n > 0;
}

export async function buildHistoricalSettlementCorrectionPlan(
  supabase: SupabaseClient,
  args: {
    tripId: string;
    allowedTripIds: readonly string[];
    dryRun?: boolean;
  },
): Promise<HistoricalSettlementCorrectionPlanResult> {
  const tripId = String(args.tripId ?? "").trim();
  const dryRun = args.dryRun !== false;

  if (!args.allowedTripIds.includes(tripId)) {
    return { status: "NOT_IN_ALLOW_LIST", tripId, dryRun };
  }

  const { data: trip } = await supabase
    .from("trips")
    .select(
      "id, trip_code, capture_amount_pence, settlement_formula_version, " +
      "commissionable_fare_pence, commission_pence, driver_net_pence, " +
      "accepted_commission_percent, commission_pct, driver_tier_commission_percent, " +
      "final_fare_pence, offer_discount_pence, discount_source, locked_base_fare_pence, " +
      "fare_snapshot_json, customer_modification_charge_pence",
    )
    .eq("id", tripId)
    .maybeSingle();

  if (!trip) {
    return { status: "TRIP_NOT_FOUND", tripId, dryRun };
  }

  const tripCode = trip.trip_code ? String(trip.trip_code) : null;

  if (!commissionRatePresent(trip as Record<string, unknown>)) {
    return {
      status: "PENDING_EVIDENCE",
      tripId,
      tripCode,
      dryRun,
      reason: "accepted commission rate missing from authoritative saved settlement evidence",
    };
  }

  const promo = classifyFrPromotionApplication(
    trip as Parameters<typeof classifyFrPromotionApplication>[0],
  );
  const corrected = calculateTripSettlementFromTripRow(trip as TripSettlementTripRow);
  if (!corrected) {
    return {
      status: "PENDING_EVIDENCE",
      tripId,
      tripCode,
      dryRun,
      reason: "canonical settlement cannot be resolved from saved evidence",
    };
  }

  const savedCommissionable = safePence(trip.commissionable_fare_pence);
  const savedCommission = safePence(trip.commission_pence);
  const savedDriverNet = safePence(trip.driver_net_pence);
  const captured = safePence(trip.capture_amount_pence);

  const correctionRequired =
    promo.promotion_application_status === "SETTLEMENT_BASE_DEFECT"
    || savedCommissionable !== corrected.commissionable_fare_pence
    || savedCommission !== corrected.commission_pence
    || savedDriverNet !== corrected.driver_net_pence;

  if (!correctionRequired) {
    return { status: "NO_CORRECTION_REQUIRED", tripId, tripCode, dryRun };
  }

  const proposedTripPatch = tripSettlementDbColumns(corrected);
  const proposedSnapshotPatch = tripSettlementSnapshotJson(corrected);
  const auditReason =
    promo.promotion_application_status === "SETTLEMENT_BASE_DEFECT"
      ? promo.promotion_application_reason
      : "Saved settlement stamps differ from canonical pre-promotion settlement";

  if (!dryRun) {
    return {
      status: "EXECUTION_DISABLED",
      tripId,
      tripCode,
      dryRun: false,
      reason: "Execution intentionally disabled until explicit approval of the reviewed dry-run plan",
    };
  }

  return {
    status: "CORRECTION_REQUIRED_DRY_RUN",
    tripId,
    tripCode,
    dryRun: true,
    captured_amount_pence: captured,
    saved: {
      commissionable_fare_pence: savedCommissionable,
      commission_pence: savedCommission,
      driver_net_pence: savedDriverNet,
    },
    corrected: {
      commissionable_fare_pence: corrected.commissionable_fare_pence,
      commission_pence: corrected.commission_pence,
      driver_net_pence: corrected.driver_net_pence,
      applied_customer_promotion_pence: corrected.applied_customer_promotion_pence,
      commission_after_promotion_pence: corrected.commission_after_promotion_pence,
      capture_amount_pence: captured,
    },
    compare_and_set: {
      id: String(trip.id),
      current_commissionable_fare_pence: savedCommissionable,
      current_commission_pence: savedCommission,
      current_driver_net_pence: savedDriverNet,
      current_capture_amount_pence: captured,
      current_settlement_formula_version: trip.settlement_formula_version != null
        ? String(trip.settlement_formula_version)
        : null,
    },
    proposed_trip_patch: proposedTripPatch,
    proposed_snapshot_patch: proposedSnapshotPatch,
    audit_reason: auditReason,
  };
}
