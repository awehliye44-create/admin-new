/**
 * Capture composition SSOT — single planner for every capture owner.
 *
 * MK-260925-002 root cause (proven):
 *   revolutCompletionCapture assigned
 *     finalFarePence = computeCaptureAmount(...).capture_amount_pence
 *   where computeCaptureAmount = final_fare_pence + tips_pence only.
 *   planRevolutCompletionCapture then set
 *     release_remainder_pence = authorisedHold − finalFare
 *   so the 36p RESERVED receivable was treated as unused hold remainder
 *   (buffer-like release semantics) without ever writing it into
 *   preauth_buffer_pence. Classification: CAPTURE_USES_CUSTOMER_PAYABLE_ONLY
 *   (C), with receivable dropped before capture POST (B).
 *
 * Typed components — never infer one from another:
 *   trip_fare_component_pence
 *   preauth_buffer_component_pence   ← explicit field only
 *   customer_receivable_component_pence ← RESERVED allocations only
 *   tip_component_pence
 *
 * Formulas:
 *   displayed_customer_total = fare + receivable
 *   provider_authorisation_target = fare + receivable + buffer
 *   provider_capture_target = fare + tip + receivable
 *   provider_release_amount = authorisation_target − capture_target
 *     (= buffer when tip=0 and fare unchanged; NEVER the receivable)
 *
 * Hard rules:
 * 1. Receivable only from same-session RESERVED allocations.
 * 2. Buffer only from an explicitly persisted buffer field — never
 *    authorised − fare / authorised − payable.
 * 3. Capture target must not exceed provider-confirmed authorised amount.
 * 4. Any 1p component mismatch fails closed before POST.
 * 5. Never use customer_payable_pence alone when RESERVED allocations exist.
 * 6. Persist composition before capture POST.
 * 7. One idempotency key for the exact capture total.
 * 8. AUTHORISED / UNKNOWN is never capture proof.
 */
import { ALLOCATION_STATUS } from "./customerReceivableSSOT.ts";

export const CAPTURE_COMPOSITION_VERSION = "capture_composition:v1" as const;

export type ReservedAllocationInput = {
  id: string;
  payment_session_id: string;
  status: string;
  allocated_amount_pence: number;
};

/** Separately typed money components — never derive across types. */
export type TypedMoneyComponents = {
  trip_fare_component_pence: number;
  preauth_buffer_component_pence: number;
  customer_receivable_component_pence: number;
  tip_component_pence: number;
};

export type TypedMoneyTargets = TypedMoneyComponents & {
  displayed_customer_total_pence: number;
  provider_authorisation_target_pence: number;
  provider_capture_target_pence: number;
  provider_release_amount_pence: number;
};

export type CaptureCompositionPlan = {
  ok: true;
  trip_fare_component_pence: number;
  tip_component_pence: number;
  receivable_component_pence: number;
  preauth_buffer_component_pence: number;
  provider_capture_target_pence: number;
  provider_authorisation_target_pence: number;
  provider_release_amount_pence: number;
  displayed_customer_total_pence: number;
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
  preauth_buffer_component_pence: number;
  provider_capture_target_pence: number;
  authorised_total_pence: number;
};

export type CaptureCompositionResult = CaptureCompositionPlan | CaptureCompositionReject;

function nonNeg(n: unknown): number {
  const v = Math.round(Number(n) || 0);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * Build typed targets from explicit components.
 * NEVER pass buffer = authorised − fare — use only the persisted buffer field.
 */
export function planTypedMoneyTargets(args: {
  trip_fare_component_pence: number;
  /** Explicit persisted buffer only — never authorisation remainder. */
  preauth_buffer_component_pence?: number | null;
  customer_receivable_component_pence?: number | null;
  tip_component_pence?: number | null;
}): TypedMoneyTargets {
  const fare = nonNeg(args.trip_fare_component_pence);
  const buffer = nonNeg(args.preauth_buffer_component_pence);
  const receivable = nonNeg(args.customer_receivable_component_pence);
  const tip = nonNeg(args.tip_component_pence);
  const displayed = fare + receivable;
  const authTarget = fare + receivable + buffer;
  const captureTarget = fare + tip + receivable;
  return {
    trip_fare_component_pence: fare,
    preauth_buffer_component_pence: buffer,
    customer_receivable_component_pence: receivable,
    tip_component_pence: tip,
    displayed_customer_total_pence: displayed,
    provider_authorisation_target_pence: authTarget,
    provider_capture_target_pence: captureTarget,
    provider_release_amount_pence: Math.max(0, authTarget - captureTarget),
  };
}

/**
 * Fail closed if a caller tries to treat (authorised − fare) as buffer while
 * receivables exist — the MK-260925-002 collapse.
 */
export function rejectAuthorisationRemainderAsBuffer(args: {
  authorised_total_pence: number;
  trip_fare_component_pence: number;
  customer_receivable_component_pence: number;
  claimed_buffer_pence: number;
}): { ok: true } | { ok: false; reject_reason: string } {
  const auth = nonNeg(args.authorised_total_pence);
  const fare = nonNeg(args.trip_fare_component_pence);
  const recv = nonNeg(args.customer_receivable_component_pence);
  const claimed = nonNeg(args.claimed_buffer_pence);
  const remainderAsBuffer = Math.max(0, auth - fare);
  if (recv > 0 && claimed === remainderAsBuffer && claimed === recv) {
    return {
      ok: false,
      reject_reason: "receivable_mistaken_for_preauth_buffer",
    };
  }
  if (recv > 0 && claimed === remainderAsBuffer && claimed > 0) {
    // claimed buffer equals whole auth−fare remainder (includes debt).
    return {
      ok: false,
      reject_reason: "buffer_derived_from_authorisation_remainder",
    };
  }
  return { ok: true };
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
  /** Explicit persisted buffer — never authorisation remainder. */
  preauth_buffer_component_pence?: number | null;
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
  const tipDeclined = args.tip_authorisation_declined === true;
  const tip = tipDeclined ? 0 : nonNeg(args.tip_component_pence);
  const explicitBuffer = nonNeg(args.preauth_buffer_component_pence);
  const sessionId = String(args.payment_session_id ?? "").trim();
  const orderId = String(args.provider_order_id ?? "").trim();
  const authorised = nonNeg(args.authorised_total_pence);
  const tripFare = nonNeg(args.trip_fare_component_pence);

  const rejectBase = {
    trip_fare_component_pence: tripFare,
    tip_component_pence: tip,
    receivable_component_pence: 0,
    preauth_buffer_component_pence: explicitBuffer,
    provider_capture_target_pence: 0,
    authorised_total_pence: authorised,
  };

  if (!sessionId) {
    return { ok: false, reject_reason: "payment_session_id_required", ...rejectBase };
  }
  if (!orderId) {
    return { ok: false, reject_reason: "provider_order_id_required", ...rejectBase };
  }
  if (authorised <= 0) {
    return { ok: false, reject_reason: "authorised_total_required", ...rejectBase };
  }

  const { receivable_component_pence, reserved_allocation_ids } =
    sumReservedReceivableComponentPence({
      payment_session_id: sessionId,
      allocations: args.allocations,
    });

  const bufferGate = rejectAuthorisationRemainderAsBuffer({
    authorised_total_pence: authorised,
    trip_fare_component_pence: tripFare,
    customer_receivable_component_pence: receivable_component_pence,
    claimed_buffer_pence: explicitBuffer,
  });
  if (!bufferGate.ok) {
    return {
      ok: false,
      reject_reason: bufferGate.reject_reason,
      trip_fare_component_pence: tripFare,
      tip_component_pence: tip,
      receivable_component_pence,
      preauth_buffer_component_pence: explicitBuffer,
      provider_capture_target_pence: 0,
      authorised_total_pence: authorised,
    };
  }

  const typed = planTypedMoneyTargets({
    trip_fare_component_pence: tripFare,
    preauth_buffer_component_pence: explicitBuffer,
    customer_receivable_component_pence: receivable_component_pence,
    tip_component_pence: tip,
  });
  const target = typed.provider_capture_target_pence;

  // Fail closed on 1p mismatch vs authorised ceiling.
  if (target > authorised) {
    return {
      ok: false,
      reject_reason: "capture_target_exceeds_authorised",
      trip_fare_component_pence: tripFare,
      tip_component_pence: tip,
      receivable_component_pence,
      preauth_buffer_component_pence: explicitBuffer,
      provider_capture_target_pence: target,
      authorised_total_pence: authorised,
    };
  }

  // Auth components must not overshoot provider-confirmed authorised.
  if (typed.provider_authorisation_target_pence > authorised) {
    return {
      ok: false,
      reject_reason: "authorisation_components_exceed_provider_authorised",
      trip_fare_component_pence: tripFare,
      tip_component_pence: tip,
      receivable_component_pence,
      preauth_buffer_component_pence: explicitBuffer,
      provider_capture_target_pence: target,
      authorised_total_pence: authorised,
    };
  }

  if (target <= 0) {
    return {
      ok: false,
      reject_reason: "capture_target_zero",
      trip_fare_component_pence: tripFare,
      tip_component_pence: tip,
      receivable_component_pence,
      preauth_buffer_component_pence: explicitBuffer,
      provider_capture_target_pence: target,
      authorised_total_pence: authorised,
    };
  }

  return {
    ok: true,
    trip_fare_component_pence: typed.trip_fare_component_pence,
    tip_component_pence: typed.tip_component_pence,
    receivable_component_pence: typed.customer_receivable_component_pence,
    preauth_buffer_component_pence: typed.preauth_buffer_component_pence,
    provider_capture_target_pence: typed.provider_capture_target_pence,
    provider_authorisation_target_pence: typed.provider_authorisation_target_pence,
    provider_release_amount_pence: typed.provider_release_amount_pence,
    displayed_customer_total_pence: typed.displayed_customer_total_pence,
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
    preauth_buffer_component_pence: plan.preauth_buffer_component_pence,
    provider_capture_target_pence: plan.provider_capture_target_pence,
    provider_authorisation_target_pence: plan.provider_authorisation_target_pence,
    provider_release_amount_pence: plan.provider_release_amount_pence,
    displayed_customer_total_pence: plan.displayed_customer_total_pence,
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

/** Incident lock helper — MK-260925-002 composition (buffer=0). */
export function mk260925002IncidentCaptureComposition(): CaptureCompositionResult {
  return planCaptureComposition({
    trip_fare_component_pence: 500,
    tip_component_pence: 0,
    preauth_buffer_component_pence: 0,
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

/**
 * Proven incident broken formula (pre-SSOT) — fare+tip only.
 * Kept for lock tests; never use as a live capture target.
 */
export function mk260925002BrokenCaptureUsesPayableOnly(args: {
  final_fare_pence: number;
  tip_pence?: number | null;
}): number {
  return nonNeg(args.final_fare_pence) + nonNeg(args.tip_pence);
}
