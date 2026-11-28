/**
 * Booking financial policy snapshot SSOT (#89).
 *
 * At booking creation the applicable Admin financial contract is frozen onto the
 * payment session / trip. Downstream lifecycle (scheduled activation, rematch,
 * modification, waiting, completion, capture, settlement, recovery) MUST read
 * this snapshot — never today's live service_area_preauth_settings.
 *
 * Live Admin settings apply prospectively to NEW bookings only.
 *
 * Does not store credentials or provider secrets.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import type { PreauthBufferResolution, PreauthBufferSource } from "./preauthBufferResolverSSOT.ts";

export const BOOKING_FINANCIAL_POLICY_VERSION = "booking_financial_policy_v1" as const;

export type BookingFinancialPolicyV1 = {
  version: typeof BOOKING_FINANCIAL_POLICY_VERSION;
  frozen_at: string;
  service_area_id: string | null;
  financial_model: string;
  payment_collection_model: string;
  payment_provider: string;
  /** Provider config identity only — never secrets. */
  provider_config_identity: string | null;
  policy_version_id: string | null;
  preauth_buffer: {
    enabled: boolean;
    buffer_type: string;
    buffer_value: number;
    buffer_pence: number;
    min_hold_pence: number | null;
    max_hold_pence: number | null;
    config_table: string;
  };
  commission: {
    formula_version: string | null;
    accepted_commission_percent: number | null;
  };
  waiting: {
    /** Waiting charges accrue under live waiting clocks; buffer headroom is frozen. */
    buffer_covers_waiting_headroom: true;
  };
  airport: {
    treatment: "pass_through_non_commissionable" | "unknown";
  };
  discount: {
    offer_discount_pence: number;
    voucher_discount_pence: number;
    discount_source: string | null;
  };
  source: "booking_create" | "legacy_reconstruct" | "recovery";
};

export function buildBookingFinancialPolicy(args: {
  frozenAt?: string;
  serviceAreaId: string | null;
  financialModel?: string | null;
  paymentCollectionModel?: string | null;
  paymentProvider?: string | null;
  providerConfigIdentity?: string | null;
  policyVersionId?: string | null;
  buffer: PreauthBufferResolution;
  commissionPercent?: number | null;
  settlementFormulaVersion?: string | null;
  offerDiscountPence?: number | null;
  voucherDiscountPence?: number | null;
  discountSource?: string | null;
  source?: BookingFinancialPolicyV1["source"];
}): BookingFinancialPolicyV1 {
  const src = args.buffer.source;
  return {
    version: BOOKING_FINANCIAL_POLICY_VERSION,
    frozen_at: args.frozenAt ?? new Date().toISOString(),
    service_area_id: args.serviceAreaId,
    financial_model: String(args.financialModel ?? "PLATFORM_COLLECTED").toUpperCase(),
    payment_collection_model: String(
      args.paymentCollectionModel ?? "PLATFORM_PREPAID",
    ).toUpperCase(),
    payment_provider: String(args.paymentProvider ?? "revolut").toLowerCase(),
    provider_config_identity: args.providerConfigIdentity ?? null,
    policy_version_id: args.policyVersionId ?? null,
    preauth_buffer: {
      enabled: !!src.enable_preauth_buffer,
      buffer_type: String(src.buffer_type ?? "none"),
      buffer_value: Number(src.buffer_value) || 0,
      buffer_pence: Math.max(0, Math.round(Number(args.buffer.bufferPence) || 0)),
      min_hold_pence: src.min_hold_pence == null ? null : Number(src.min_hold_pence),
      max_hold_pence: src.max_hold_pence == null ? null : Number(src.max_hold_pence),
      config_table: String(src.config_table ?? "public.service_area_preauth_settings"),
    },
    commission: {
      formula_version: args.settlementFormulaVersion ?? null,
      accepted_commission_percent: args.commissionPercent == null
        ? null
        : Number(args.commissionPercent),
    },
    waiting: { buffer_covers_waiting_headroom: true },
    airport: { treatment: "pass_through_non_commissionable" },
    discount: {
      offer_discount_pence: Math.max(0, Math.round(Number(args.offerDiscountPence) || 0)),
      voucher_discount_pence: Math.max(0, Math.round(Number(args.voucherDiscountPence) || 0)),
      discount_source: args.discountSource ?? null,
    },
    source: args.source ?? "booking_create",
  };
}

export function parseBookingFinancialPolicy(
  raw: unknown,
): BookingFinancialPolicyV1 | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (String(o.version ?? "") !== BOOKING_FINANCIAL_POLICY_VERSION) return null;
  const buf = o.preauth_buffer && typeof o.preauth_buffer === "object"
    ? o.preauth_buffer as Record<string, unknown>
    : null;
  if (!buf) return null;
  return o as BookingFinancialPolicyV1;
}

/**
 * Authoritative frozen buffer for an existing booking.
 * Never falls back to live Admin settings.
 */
export function resolveFrozenPreauthBufferPence(args: {
  policy?: BookingFinancialPolicyV1 | null;
  sessionBufferPence?: number | null;
  tripPreauthBufferPence?: number | null;
  fareSnapshotBufferPence?: number | null;
}): {
  bufferPence: number;
  source: "policy" | "session" | "trip" | "fare_snapshot" | "missing";
  insufficient_historical_evidence: boolean;
} {
  const fromPolicy = args.policy
    ? Math.max(0, Math.round(Number(args.policy.preauth_buffer.buffer_pence) || 0))
    : null;
  if (args.policy && fromPolicy != null) {
    return {
      bufferPence: fromPolicy,
      source: "policy",
      insufficient_historical_evidence: false,
    };
  }
  const session = Math.round(Number(args.sessionBufferPence));
  if (Number.isFinite(session) && session >= 0 && args.sessionBufferPence != null) {
    return {
      bufferPence: Math.max(0, session),
      source: "session",
      insufficient_historical_evidence: false,
    };
  }
  const trip = Math.round(Number(args.tripPreauthBufferPence));
  if (Number.isFinite(trip) && trip >= 0 && args.tripPreauthBufferPence != null) {
    return {
      bufferPence: Math.max(0, trip),
      source: "trip",
      insufficient_historical_evidence: false,
    };
  }
  const snap = Math.round(Number(args.fareSnapshotBufferPence));
  if (Number.isFinite(snap) && snap >= 0 && args.fareSnapshotBufferPence != null) {
    return {
      bufferPence: Math.max(0, snap),
      source: "fare_snapshot",
      insufficient_historical_evidence: false,
    };
  }
  return {
    bufferPence: 0,
    source: "missing",
    insufficient_historical_evidence: true,
  };
}

/** Reconstruct a policy for legacy bookings from authoritative frozen fields. */
export function reconstructLegacyBookingFinancialPolicy(args: {
  serviceAreaId: string | null;
  financialModel?: string | null;
  paymentProvider?: string | null;
  bufferPence: number;
  bufferSourceHint?: Partial<PreauthBufferSource> | null;
  offerDiscountPence?: number | null;
  voucherDiscountPence?: number | null;
  discountSource?: string | null;
  frozenAt?: string | null;
}): BookingFinancialPolicyV1 {
  const bufferPence = Math.max(0, Math.round(Number(args.bufferPence) || 0));
  const hint = args.bufferSourceHint ?? {};
  return buildBookingFinancialPolicy({
    frozenAt: args.frozenAt ?? undefined,
    serviceAreaId: args.serviceAreaId,
    financialModel: args.financialModel,
    paymentProvider: args.paymentProvider,
    buffer: {
      bufferPence,
      source: {
        service_area_id: args.serviceAreaId,
        enable_preauth_buffer: bufferPence > 0 || !!hint.enable_preauth_buffer,
        buffer_type: String(hint.buffer_type ?? (bufferPence > 0 ? "fixed" : "none")),
        buffer_value: Number(hint.buffer_value ?? (bufferPence > 0 ? bufferPence / 100 : 0)),
        min_hold_pence: hint.min_hold_pence ?? null,
        max_hold_pence: hint.max_hold_pence ?? null,
        config_table: String(hint.config_table ?? "public.service_area_preauth_settings"),
      },
    },
    offerDiscountPence: args.offerDiscountPence,
    voucherDiscountPence: args.voucherDiscountPence,
    discountSource: args.discountSource,
    source: "legacy_reconstruct",
  });
}
