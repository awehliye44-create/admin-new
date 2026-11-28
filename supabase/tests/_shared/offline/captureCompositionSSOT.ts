/** Offline test/audit-only helpers; not part of Edge uploads. */
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
import { ALLOCATION_STATUS } from "../../../functions/_shared/customerReceivableSSOT.ts";
import { CaptureCompositionPlan, CaptureCompositionResult, planCaptureComposition, nonNeg } from "../../../functions/_shared/captureCompositionSSOT.ts";


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

export * from "../../../functions/_shared/captureCompositionSSOT.ts";
