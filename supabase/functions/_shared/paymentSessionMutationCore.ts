/**
 * Sole owner of payment_sessions UPDATE mutations (Phase 0b).
 * All writers must route through this module or paymentSessionTransitionFacade.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";

export type PaymentSessionMutationSource =
  | "webhook"
  | "sweep"
  | "admin_remediate"
  | "admin_refresh"
  | "capture_persist"
  | "hold_release"
  | "terminal_disposition"
  | "recovery"
  | "fee_backfill"
  | "financial_lock"
  | "ssot"
  | "facade";

export type PaymentSessionMutationFilter = {
  sessionId?: string | null;
  clientActionId?: string | null;
  providerOrderId?: string | null;
  expectStatus?: string | null;
  expectFinancialOperationState?: string | null;
  expectFinancialOperationOwner?: string | null;
};

export async function mutatePaymentSession(
  supabase: SupabaseClient,
  filter: PaymentSessionMutationFilter,
  patch: Record<string, unknown>,
  source: PaymentSessionMutationSource,
): Promise<{ ok: boolean; error?: string }> {
  const body = {
    ...patch,
    updated_at: new Date().toISOString(),
  };
  if (body.metadata && typeof body.metadata === "object") {
    body.metadata = {
      ...(body.metadata as Record<string, unknown>),
      mutation_source: source,
    };
  }

  let query = supabase.from("payment_sessions").update(body);

  if (filter.sessionId) {
    query = query.eq("id", filter.sessionId);
  } else if (filter.clientActionId) {
    query = query.eq("client_action_id", filter.clientActionId);
  } else if (filter.providerOrderId) {
    query = query.eq("provider_order_id", filter.providerOrderId);
  } else {
    return { ok: false, error: "missing_session_identity" };
  }

  if (filter.expectStatus) {
    query = query.eq("status", filter.expectStatus);
  }
  if (filter.expectFinancialOperationState) {
    query = query.eq("financial_operation_state", filter.expectFinancialOperationState);
  }
  const ownerEq = String(filter.expectFinancialOperationOwner ?? "").trim();
  if (ownerEq) {
    query = query.eq("financial_operation_owner", ownerEq);
  }

  const { error } = await query;
  if (error) {
    console.warn("[paymentSessionMutationCore] update failed", error.message, source);
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

/** CAS claim with returning id (financial lock). */
export async function mutatePaymentSessionReturningId(
  supabase: SupabaseClient,
  filter: PaymentSessionMutationFilter,
  patch: Record<string, unknown>,
  source: PaymentSessionMutationSource,
): Promise<{ ok: boolean; id?: string; error?: string }> {
  const body = {
    ...patch,
    updated_at: new Date().toISOString(),
  };

  let query = supabase.from("payment_sessions").update(body);

  if (filter.sessionId) {
    query = query.eq("id", filter.sessionId);
  } else {
    return { ok: false, error: "missing_session_identity" };
  }

  const ownerEq = String(filter.expectFinancialOperationOwner ?? "").trim();
  if (ownerEq) {
    query = query.eq("financial_operation_owner", ownerEq);
  }

  const { data, error } = await query.select("id").maybeSingle();
  if (error || !data?.id) {
    return { ok: false, error: error?.message ?? "claim_failed" };
  }
  return { ok: true, id: String(data.id) };
}
