/**
 * Staged Payment SSOT cutover (A–E). Feature flags alone are insufficient for
 * legacy writers; Stage D enables DB-enforced strictness after all paths are compatible.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";

export type PaymentSsotCutoverStage = "A" | "B" | "C" | "D" | "E";

export type PaymentSsotCutoverConfig = {
  stage: PaymentSsotCutoverStage;
  /** When true, INCREMENT/CAPTURE POST requires successful claimFinancialOperationForPost. */
  require_financial_op_claim: boolean;
  /** When true, trips.capture_amount_pence mirror trigger is active (Stage D+). */
  strict_trip_capture_mirror: boolean;
};

const DEFAULT_CONFIG: PaymentSsotCutoverConfig = {
  stage: "A",
  require_financial_op_claim: false,
  strict_trip_capture_mirror: false,
};

let cached: { at: number; config: PaymentSsotCutoverConfig } | null = null;
const CACHE_MS = 5_000;

export async function loadPaymentSsotCutoverConfig(
  supabase: SupabaseClient,
): Promise<PaymentSsotCutoverConfig> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.config;
  try {
    const { data, error } = await supabase
      .from("payment_ssot_cutover")
      .select("stage, require_financial_op_claim, strict_trip_capture_mirror")
      .eq("id", 1)
      .maybeSingle();
    if (error || !data) {
      cached = { at: Date.now(), config: DEFAULT_CONFIG };
      return DEFAULT_CONFIG;
    }
    const stage = String(data.stage ?? "A").toUpperCase() as PaymentSsotCutoverStage;
    const config: PaymentSsotCutoverConfig = {
      stage: ["A", "B", "C", "D", "E"].includes(stage) ? stage : "A",
      require_financial_op_claim: data.require_financial_op_claim === true,
      strict_trip_capture_mirror: data.strict_trip_capture_mirror === true,
    };
    cached = { at: Date.now(), config };
    return config;
  } catch {
    cached = { at: Date.now(), config: DEFAULT_CONFIG };
    return DEFAULT_CONFIG;
  }
}
