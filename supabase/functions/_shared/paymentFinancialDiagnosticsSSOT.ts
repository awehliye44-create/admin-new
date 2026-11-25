/**
 * P0 sanitised payment diagnostics. Never store credentials/PAN/tokens.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";

const FORBIDDEN_DETAIL_KEYS = new Set([
  "password",
  "secret",
  "token",
  "authorization",
  "pan",
  "card_number",
  "cvv",
  "cvc",
  "payment_method_token",
  "client_secret",
  "refresh_token",
  "access_token",
]);

export function sanitiseFinancialEventDetail(
  detail: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!detail || typeof detail !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(detail)) {
    if (FORBIDDEN_DETAIL_KEYS.has(k.toLowerCase())) continue;
    if (typeof v === "string" && v.length > 2000) {
      out[k] = `${v.slice(0, 2000)}…`;
      continue;
    }
    out[k] = v;
  }
  return out;
}

export async function recordPaymentFinancialEvent(
  supabase: SupabaseClient,
  args: {
    paymentSessionId?: string | null;
    tripId?: string | null;
    operationId?: string | null;
    executionId?: string | null;
    fence?: string | null;
    opType?: string | null;
    eventType: string;
    httpStatus?: number | null;
    providerCorrelationId?: string | null;
    requestedAmountPence?: number | null;
    providerConfirmedAmountPence?: number | null;
    providerResponseState?: string | null;
    declineCode?: string | null;
    idempotencyReference?: string | null;
    detail?: Record<string, unknown> | null;
  },
): Promise<void> {
  try {
    await supabase.from("payment_financial_events").insert({
      payment_session_id: args.paymentSessionId ?? null,
      trip_id: args.tripId ?? null,
      operation_id: args.operationId ?? null,
      execution_id: args.executionId ?? null,
      fence: args.fence ?? null,
      op_type: args.opType ?? null,
      event_type: String(args.eventType),
      http_status: args.httpStatus ?? null,
      provider_correlation_id: args.providerCorrelationId ?? null,
      requested_amount_pence: args.requestedAmountPence ?? null,
      provider_confirmed_amount_pence: args.providerConfirmedAmountPence ?? null,
      provider_response_state: args.providerResponseState ?? null,
      decline_code: args.declineCode ?? null,
      idempotency_reference: args.idempotencyReference ?? null,
      detail: sanitiseFinancialEventDetail(args.detail),
    });
  } catch (err) {
    console.error("[paymentFinancialDiagnosticsSSOT] record failed", err);
  }
}
