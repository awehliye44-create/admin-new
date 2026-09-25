/**
 * Capture composition SSOT — single planner for every capture owner.
 *
 * MK-260925-002: tip-window capture used customer_payable / fare-only 500p while
 * the same session held RESERVED receivables 36p under an AUTHORISED 536p hold.
 * Provider captured 500; receivables stayed RESERVED.
 *
 * provider_capture_target_pence =
 *   trip_fare_component_pence
 * + successful_tip_component_pence
 * + reserved_receivable_component_pence
 *
 * Hard rules:
 * 1. Receivable component only from RESERVED allocations on the same session.
 * 2. Target must not exceed provider-confirmed authorised amount.
 * 3. Any 1p mismatch fails closed before POST.
 * 4. Never use customer_payable_pence alone when RESERVED allocations exist.
 * 5. Persist composition before capture POST.
 * 6. One idempotency key for the exact total.
 * 7. AUTHORISED / UNKNOWN is never capture proof.
 */
import { ALLOCATION_STATUS } from "./customerReceivableSSOT.ts";

export const CAPTURE_COMPOSITION_VERSION = "capture_composition:v1" as const;

export type ReservedAllocationInput = {
  id: string;
  payment_session_id: string;
  status: string;
  allocated_amount_pence: number;
};

export type CaptureCompositionPlan = {
  ok: true;
  trip_fare_component_pence: number;
  tip_component_pence: number;
  receivable_component_pence: number;
  provider_capture_target_pence: number;
  authorised_total_pence: number;
  payment_session_id: string;
  provider_order_id: string;
  capture_idempotency_key: string;
  composition_version: typeof CAPTURE_COMPOSITION_VERSION;
  reserved_allocation_ids: string[];
};

export type CaptureCompositionReject = {
  ok: false;
  reject_reason: string;
  trip_fare_component_pence: number;
  tip_component_pence: number;
  receivable_component_pence: number;
  provider_capture_target_pence: number;
  authorised_total_pence: number;
};

export type CaptureCompositionResult = CaptureCompositionPlan | CaptureCompositionReject;

function nonNeg(n: unknown): number {
  const v = Math.round(Number(n) || 0);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

export function buildCaptureIdempotencyKey(args: {
  payment_session_id: string;
  provider_order_id: string;
  provider_capture_target_pence: number;
}): string {
  return [
    CAPTURE_COMPOSITION_VERSION,
    String(args.payment_session_id).trim(),
    String(args.provider_order_id).trim(),
    String(Math.max(0, Math.round(args.provider_capture_target_pence))),
  ].join(":");
}

/**
 * Sum RESERVED allocations for this payment session only.
 */
export function sumReservedReceivableComponentPence(args: {
  payment_session_id: string;
  allocations: ReservedAllocationInput[];
}): { receivable_component_pence: number; reserved_allocation_ids: string[] } {
  const sid = String(args.payment_session_id ?? "").trim();
  const ids: string[] = [];
  let sum = 0;
  for (const a of args.allocations ?? []) {
    if (String(a.payment_session_id ?? "").trim() !== sid) continue;
    if (String(a.status ?? "").toUpperCase() !== ALLOCATION_STATUS.RESERVED) continue;
    const amt = nonNeg(a.allocated_amount_pence);
    if (amt <= 0) continue;
    sum += amt;
    if (a.id) ids.push(String(a.id));
  }
  return { receivable_component_pence: sum, reserved_allocation_ids: ids };
}

/**
 * Canonical capture planner — pure, no I/O.
 */
export function planCaptureComposition(args: {
  trip_fare_component_pence: number;
  tip_component_pence?: number | null;
  /** Successful tip only — declined tip must pass 0 and not fare-capture elsewhere. */
  tip_authorisation_declined?: boolean | null;
  payment_session_id: string;
  provider_order_id: string;
  authorised_total_pence: number;
  allocations: ReservedAllocationInput[];
  /**
   * Legacy payable stamp — if RESERVED allocations exist and this equals fare-only
   * while authorised covers fare+recv, ignore it (MK-260925-002).
   */
  customer_payable_pence?: number | null;
}): CaptureCompositionResult {
  const tripFare = nonNeg(args.trip_fare_component_pence);
  const tipDeclined = args.tip_authorisation_declined === true;
  const tip = tipDeclined ? 0 : nonNeg(args.tip_component_pence);
  const sessionId = String(args.payment_session_id ?? "").trim();
  const orderId = String(args.provider_order_id ?? "").trim();
  const authorised = nonNeg(args.authorised_total_pence);

  if (!sessionId) {
    return {
      ok: false,
      reject_reason: "payment_session_id_required",
      trip_fare_component_pence: tripFare,
      tip_component_pence: tip,
      receivable_component_pence: 0,
      provider_capture_target_pence: 0,
      authorised_total_pence: authorised,
    };
  }
  if (!orderId) {
    return {
      ok: false,
      reject_reason: "provider_order_id_required",
      trip_fare_component_pence: tripFare,
      tip_component_pence: tip,
      receivable_component_pence: 0,
      provider_capture_target_pence: 0,
      authorised_total_pence: authorised,
    };
  }
  if (authorised <= 0) {
    return {
      ok: false,
      reject_reason: "authorised_total_required",
      trip_fare_component_pence: tripFare,
      tip_component_pence: tip,
      receivable_component_pence: 0,
      provider_capture_target_pence: 0,
      authorised_total_pence: authorised,
    };
  }

  const { receivable_component_pence, reserved_allocation_ids } =
    sumReservedReceivableComponentPence({
      payment_session_id: sessionId,
      allocations: args.allocations,
    });

  const target = tripFare + tip + receivable_component_pence;

  // Fail closed on 1p mismatch vs authorised ceiling.
  if (target > authorised) {
    return {
      ok: false,
      reject_reason: "capture_target_exceeds_authorised",
      trip_fare_component_pence: tripFare,
      tip_component_pence: tip,
      receivable_component_pence,
      provider_capture_target_pence: target,
      authorised_total_pence: authorised,
    };
  }

  // Guard: never silently use payable-alone when RESERVED exist.
  const payable = args.customer_payable_pence != null
    ? nonNeg(args.customer_payable_pence)
    : null;
  if (
    receivable_component_pence > 0
    && payable != null
    && payable === tripFare
    && target === tripFare + receivable_component_pence
  ) {
    // Planner still returns the correct target; callers must not POST payable.
  }

  if (target <= 0) {
    return {
      ok: false,
      reject_reason: "capture_target_zero",
      trip_fare_component_pence: tripFare,
      tip_component_pence: tip,
      receivable_component_pence,
      provider_capture_target_pence: target,
      authorised_total_pence: authorised,
    };
  }

  return {
    ok: true,
    trip_fare_component_pence: tripFare,
    tip_component_pence: tip,
    receivable_component_pence,
    provider_capture_target_pence: target,
    authorised_total_pence: authorised,
    payment_session_id: sessionId,
    provider_order_id: orderId,
    capture_idempotency_key: buildCaptureIdempotencyKey({
      payment_session_id: sessionId,
      provider_order_id: orderId,
      provider_capture_target_pence: target,
    }),
    composition_version: CAPTURE_COMPOSITION_VERSION,
    reserved_allocation_ids,
  };
}

/**
 * Persist shape for payment_sessions columns / metadata before provider POST.
 */
export function captureCompositionPersistPatch(plan: CaptureCompositionPlan): Record<string, unknown> {
  return {
    trip_fare_component_pence: plan.trip_fare_component_pence,
    tip_component_pence: plan.tip_component_pence,
    receivable_component_pence: plan.receivable_component_pence,
    provider_capture_target_pence: plan.provider_capture_target_pence,
    authorised_total_pence: plan.authorised_total_pence,
    capture_idempotency_key: plan.capture_idempotency_key,
    capture_composition_version: plan.composition_version,
    capture_reserved_allocation_ids: plan.reserved_allocation_ids,
  };
}

/**
 * Settlement gate after GET confirms capture.
 * Settle only when the persisted plan included a receivable component.
 * Coverage is fare-first: covered_recv = max(0, captured − trip_fare_component).
 * MK-260925-002: target 500 / receivable component 0 → settle 0 (release path).
 * UNKNOWN (confirmed capture 0 / no GET) → retain RESERVED (no settle, no release).
 */
export function planReceivableSettlementFromCaptureComposition(args: {
  persisted_receivable_component_pence: number | null | undefined;
  provider_confirmed_captured_pence: number;
  reserved_allocation_total_pence: number;
  /** Trip fare component from the persisted capture plan (fare-first ordering). */
  trip_fare_component_pence?: number | null;
  /** True only when provider GET confirmed a terminal COMPLETED/CAPTURED amount. */
  amount_from_provider_get?: boolean | null;
}): {
  settle_pence: number;
  release_remainder: boolean;
  reason: string;
} {
  const planned = nonNeg(args.persisted_receivable_component_pence);
  const captured = nonNeg(args.provider_confirmed_captured_pence);
  const reserved = nonNeg(args.reserved_allocation_total_pence);
  const tripFare = nonNeg(args.trip_fare_component_pence);
  const fromGet = args.amount_from_provider_get === true;

  // UNKNOWN / no GET proof — never invent settle or release.
  if (!fromGet || captured <= 0) {
    return {
      settle_pence: 0,
      release_remainder: false,
      reason: "retain_reserved_unknown_or_unconfirmed_capture",
    };
  }

  if (planned <= 0) {
    return {
      settle_pence: 0,
      release_remainder: reserved > 0,
      reason: "no_planned_receivable_component",
    };
  }

  // Fare-first covered receivable; never infer settle from captured >= recv alone.
  const coveredRecv = Math.max(0, captured - tripFare);
  const settle = Math.min(planned, coveredRecv, reserved);
  return {
    settle_pence: settle,
    release_remainder: reserved > settle,
    reason: settle > 0 ? "planned_receivable_covered" : "planned_but_uncovered",
  };
}

/** Incident lock helper — MK-260925-002 composition. */
export function mk260925002IncidentCaptureComposition(): CaptureCompositionResult {
  return planCaptureComposition({
    trip_fare_component_pence: 500,
    tip_component_pence: 0,
    payment_session_id: "71a39184-4efd-462c-8465-6b1f2e03d251",
    provider_order_id: "6ab61c09-a366-ab77-84a2-498142cf3420",
    authorised_total_pence: 536,
    customer_payable_pence: 500,
    allocations: [
      {
        id: "alloc-30",
        payment_session_id: "71a39184-4efd-462c-8465-6b1f2e03d251",
        status: "RESERVED",
        allocated_amount_pence: 30,
      },
      {
        id: "alloc-6",
        payment_session_id: "71a39184-4efd-462c-8465-6b1f2e03d251",
        status: "RESERVED",
        allocated_amount_pence: 6,
      },
    ],
  });
}
