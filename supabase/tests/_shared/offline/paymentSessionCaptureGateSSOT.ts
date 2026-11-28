/** Offline test/audit-only helpers; not part of Edge uploads. */
/**
 * Payment Sessions capture-gate read contract (production schema SSOT).
 * financial_model lives on trips only — never select it from payment_sessions.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";

import type { PaymentSessionCaptureGate } from "../../../functions/_shared/postCaptureSettlementBoundary.ts";
import { PAYMENT_SESSION_CAPTURE_GATE_SELECT } from "../../../functions/_shared/paymentSessionCaptureGateSSOT.ts";


export function paymentSessionCaptureGateSelectColumns(): string[] {
  return PAYMENT_SESSION_CAPTURE_GATE_SELECT.split(/,\s*/).map((c) => c.trim()).filter(Boolean);
}

export * from "../../../functions/_shared/paymentSessionCaptureGateSSOT.ts";
