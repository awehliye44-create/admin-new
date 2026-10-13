/**
 * Load session RESERVED allocations and build a capture composition plan.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  captureCompositionPersistPatch,
  planCaptureComposition,
  type CaptureCompositionResult,
  type ReservedAllocationInput,
} from "./captureCompositionSSOT.ts";

export async function loadPlanAndPersistCaptureComposition(
  supabase: SupabaseClient,
  args: {
    payment_session_id: string;
    provider_order_id: string;
    trip_fare_component_pence: number;
    tip_component_pence?: number;
    tip_authorisation_declined?: boolean;
    authorised_total_pence: number;
    customer_payable_pence?: number | null;
    /** Explicit session/trip buffer — never authorisation remainder. */
    preauth_buffer_component_pence?: number | null;
  },
): Promise<CaptureCompositionResult> {
  const sessionId = String(args.payment_session_id ?? "").trim();
  const { data: allocRows } = await supabase
    .from("payment_session_receivable_allocations")
    .select("id, payment_session_id, status, allocated_amount_pence")
    .eq("payment_session_id", sessionId)
    .eq("status", "RESERVED");

  const allocations: ReservedAllocationInput[] = (allocRows ?? []).map((r) => ({
    id: String((r as { id?: string }).id ?? ""),
    payment_session_id: String((r as { payment_session_id?: string }).payment_session_id ?? sessionId),
    status: String((r as { status?: string }).status ?? ""),
    allocated_amount_pence: Math.round(
      Number((r as { allocated_amount_pence?: number }).allocated_amount_pence) || 0,
    ),
  }));

  const { data: sessionRow } = await supabase
    .from("payment_sessions")
    .select("metadata, authorised_amount_pence, total_authorised_amount_pence, buffer_pence")
    .eq("id", sessionId)
    .maybeSingle();

  const meta = sessionRow?.metadata && typeof sessionRow.metadata === "object"
    ? { ...(sessionRow.metadata as Record<string, unknown>) }
    : {};
  const payable = args.customer_payable_pence != null
    ? args.customer_payable_pence
    : meta.customer_payable_pence != null
    ? Number(meta.customer_payable_pence)
    : null;

  const explicitBuffer = args.preauth_buffer_component_pence != null
    ? Math.max(0, Math.round(Number(args.preauth_buffer_component_pence) || 0))
    : Math.max(0, Math.round(Number(sessionRow?.buffer_pence) || 0));

  const plan = planCaptureComposition({
    trip_fare_component_pence: args.trip_fare_component_pence,
    tip_component_pence: args.tip_component_pence ?? 0,
    tip_authorisation_declined: args.tip_authorisation_declined === true,
    preauth_buffer_component_pence: explicitBuffer,
    payment_session_id: sessionId,
    provider_order_id: args.provider_order_id,
    authorised_total_pence: args.authorised_total_pence,
    allocations,
    customer_payable_pence: payable,
  });

  if (!plan.ok) return plan;

  const patch = captureCompositionPersistPatch(plan);
  const nextMeta = { ...meta, ...patch, capture_composition_persisted_at: new Date().toISOString() };
  // Columns from migration 20260925120000; remaining typed fields live in metadata only.
  await supabase
    .from("payment_sessions")
    .update({
      trip_fare_component_pence: plan.trip_fare_component_pence,
      tip_component_pence: plan.tip_component_pence,
      receivable_component_pence: plan.receivable_component_pence,
      provider_capture_target_pence: plan.provider_capture_target_pence,
      capture_composition_version: plan.composition_version,
      capture_idempotency_key: plan.capture_idempotency_key,
      metadata: nextMeta,
      updated_at: new Date().toISOString(),
    })
    .eq("id", sessionId);

  return plan;
}
