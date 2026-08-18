/**
 * Payment Sessions capture-gate read contract (production schema SSOT).
 * financial_model lives on trips only — never select it from payment_sessions.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import type { PaymentSessionCaptureGate } from "./postCaptureSettlementBoundary.ts";

/** Authoritative PostgREST select for wallet / recovery capture gates. */
export const PAYMENT_SESSION_CAPTURE_GATE_SELECT =
  "id, status, provider_state, captured_amount_pence, captured_at, provider_state_verified_at, purpose, financial_operation_state, financial_operation_owner, provider_order_id, provider_capture_id, refunded_amount_pence, released_amount_pence, hold_release_state, hold_terminal_reason, metadata";

export type PaymentSessionGateRow = PaymentSessionCaptureGate & {
  id?: string | null;
  financial_operation_state?: string | null;
  financial_operation_owner?: string | null;
  provider_order_id?: string | null;
  provider_capture_id?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type PaymentSessionCaptureGateLoadResult = {
  session: PaymentSessionGateRow | null;
  error: { code?: string; message: string } | null;
};

export function paymentSessionCaptureGateSelectColumns(): string[] {
  return PAYMENT_SESSION_CAPTURE_GATE_SELECT.split(/,\s*/).map((c) => c.trim()).filter(Boolean);
}

function normalizeGateRow(
  data: unknown,
): PaymentSessionGateRow | null {
  return data && typeof data === "object" ? data as PaymentSessionGateRow : null;
}

export async function loadPaymentSessionCaptureGate(
  supabase: SupabaseClient,
  tripId: string,
): Promise<PaymentSessionCaptureGateLoadResult> {
  const { data, error } = await supabase
    .from("payment_sessions")
    .select(PAYMENT_SESSION_CAPTURE_GATE_SELECT)
    .eq("trip_id", tripId)
    .neq("purpose", "PAYMENT_RECOVERY")
    .order("captured_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    return {
      session: null,
      error: {
        code: typeof error.code === "string" ? error.code : undefined,
        message: typeof error.message === "string" ? error.message : String(error),
      },
    };
  }

  return { session: normalizeGateRow(data), error: null };
}

export type WalletRecoveryPaymentSessionLoadResult = {
  sessions: PaymentSessionGateRow[];
  error: { code?: string; message: string } | null;
};

/** All non-recovery Payment Sessions for one trip — recovery must prove count === 1. */
export async function loadWalletRecoveryPaymentSessions(
  supabase: SupabaseClient,
  tripId: string,
): Promise<WalletRecoveryPaymentSessionLoadResult> {
  const { data, error } = await supabase
    .from("payment_sessions")
    .select(PAYMENT_SESSION_CAPTURE_GATE_SELECT)
    .eq("trip_id", tripId)
    .neq("purpose", "PAYMENT_RECOVERY");

  if (error) {
    return {
      sessions: [],
      error: {
        code: typeof error.code === "string" ? error.code : undefined,
        message: typeof error.message === "string" ? error.message : String(error),
      },
    };
  }

  const sessions = (Array.isArray(data) ? data : [])
    .map((row) => normalizeGateRow(row))
    .filter((row): row is PaymentSessionGateRow => row != null);
  return { sessions, error: null };
}
