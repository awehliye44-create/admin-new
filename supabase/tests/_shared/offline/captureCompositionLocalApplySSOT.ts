/** Offline test/audit-only helpers; not part of Edge uploads. */
import { CaptureCompositionComponents, nonNeg, LocalApplicationOutcome } from "../../../functions/_shared/captureCompositionLocalApplySSOT.ts";


/**
 * Fare base for trip stamps / TEN / commission.
 * Never uses provider capture total when composition fare is known
 * (capture total may include receivable recovery).
 */
export function tripFareForEconomicStamps(args: {
  composition: CaptureCompositionComponents | null;
  fallback_final_fare_pence?: number | null;
  provider_captured_pence?: number | null;
}): number {
  const fromComposition = nonNeg(args.composition?.trip_fare_component_pence);
  if (fromComposition > 0) return fromComposition;
  const fallback = nonNeg(args.fallback_final_fare_pence);
  if (fallback > 0) return fallback;
  // Last resort legacy: only when no composition — do not invent from capture+recv.
  return 0;
}


export function markLocalApplicationIncomplete(reason: string): LocalApplicationOutcome {
  return {
    provider_capture_persisted: true,
    trip_stamps_applied: false,
    receivables_settled: false,
    ten_posted_or_verified: false,
    incomplete: true,
    incomplete_reason: reason,
    manual_review: true,
  };
}


/**
 * Commission round-half-up from fare component only (UK pence).
 */
export function commissionFromTripFareComponent(
  tripFarePence: number,
  commissionPercent: number,
): { commission_pence: number; driver_net_pence: number } {
  const fare = nonNeg(tripFarePence);
  const pct = Number(commissionPercent);
  const rate = Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 0;
  const commission = Math.round((fare * rate) / 100);
  return {
    commission_pence: commission,
    driver_net_pence: Math.max(0, fare - commission),
  };
}


/** Component ownership lock — what each immutable field may stamp. */
export const COMPONENT_OWNERSHIP = {
  trip_fare_component_pence: [
    "gross_fare_pence",
    "final_fare_pence",
    "commissionable_fare_pence",
    "commission_pence",
    "driver_net_pence",
    "driver_total_earnings_pence",
    "TRIP_EARNING_NET",
  ],
  receivable_component_pence: [
    "customer_receivable_settle",
  ],
  tip_component_pence: [
    "tip_pence",
    "tip_amount_pence",
    "DRIVER_TIP_CREDIT",
  ],
  buffer_component_pence: [
    "authorisation_capacity",
    "provider_release_amount",
  ],
} as const;


/**
 * Pure local-application policy for a provider terminal state.
 * Never authorises a re-POST after local failure — GET-first only.
 */
export function planLocalApplicationForProviderState(args: {
  provider_state: string;
  composition: CaptureCompositionComponents | null;
  provider_evidence_from_get: boolean;
  reserved_allocation_total_pence: number;
  existing_ten_count: number;
  trip_stamps_match_fare_component: boolean;
  receivables_already_settled: boolean;
}): {
  may_stamp_trip: boolean;
  may_settle_receivables: boolean;
  may_post_ten: boolean;
  retain_reservations: boolean;
  allow_capture_post: boolean;
  require_get_first: boolean;
  mark_incomplete: boolean;
  reason: string;
} {
  const state = String(args.provider_state ?? "").toUpperCase();
  const recv = nonNeg(args.composition?.receivable_component_pence);
  const reserved = Math.max(0, Math.round(Number(args.reserved_allocation_total_pence) || 0));

  if (state === "AUTHORISED" || state === "AUTHORIZED") {
    return {
      may_stamp_trip: false,
      may_settle_receivables: false,
      may_post_ten: false,
      retain_reservations: true,
      allow_capture_post: true,
      require_get_first: false,
      mark_incomplete: false,
      reason: "authorised_retain_reserved",
    };
  }

  if (state === "UNKNOWN" || state === "") {
    return {
      may_stamp_trip: false,
      may_settle_receivables: false,
      may_post_ten: false,
      retain_reservations: true,
      allow_capture_post: false,
      require_get_first: true,
      mark_incomplete: false,
      reason: "unknown_get_first_retain_reserved",
    };
  }

  if (state === "LOCAL_APPLICATION_INCOMPLETE" || state === "MANUAL_REVIEW") {
    return {
      may_stamp_trip: !args.trip_stamps_match_fare_component,
      may_settle_receivables: recv > 0 && reserved > 0 && !args.receivables_already_settled,
      may_post_ten: args.existing_ten_count === 0,
      retain_reservations: reserved > 0 && !args.receivables_already_settled,
      allow_capture_post: false,
      require_get_first: true,
      mark_incomplete: true,
      reason: "local_incomplete_retry_missing_only",
    };
  }

  if (state !== "COMPLETED" && state !== "CAPTURED") {
    return {
      may_stamp_trip: false,
      may_settle_receivables: false,
      may_post_ten: false,
      retain_reservations: true,
      allow_capture_post: false,
      require_get_first: true,
      mark_incomplete: false,
      reason: `non_terminal_${state.toLowerCase()}`,
    };
  }

  if (!args.provider_evidence_from_get) {
    return {
      may_stamp_trip: false,
      may_settle_receivables: false,
      may_post_ten: false,
      retain_reservations: true,
      allow_capture_post: false,
      require_get_first: true,
      mark_incomplete: recv > 0,
      reason: "completed_without_get_evidence",
    };
  }

  return {
    may_stamp_trip: !args.trip_stamps_match_fare_component,
    may_settle_receivables: recv > 0 && reserved > 0 && !args.receivables_already_settled,
    may_post_ten: args.existing_ten_count === 0,
    retain_reservations: false,
    allow_capture_post: false,
    require_get_first: false,
    mark_incomplete: false,
    reason: "completed_apply_local_components",
  };
}


/**
 * True when provider capture total must not be used as trip fare
 * (any non-fare component present on the frozen composition).
 */
export function providerCaptureMustNotBecomeTripFare(
  composition: CaptureCompositionComponents | null,
): boolean {
  if (!composition) return false;
  return (
    composition.receivable_component_pence > 0
    || composition.tip_component_pence > 0
    || composition.preauth_buffer_component_pence > 0
  );
}

export * from "../../../functions/_shared/captureCompositionLocalApplySSOT.ts";
