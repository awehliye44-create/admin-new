/**
 * Revolut trip capture at complete — delegates to hold reconciliation SSOT.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import { executeRevolutTripCompletionCapture } from "./revolutCompletionCapture.ts";

export type FinalizeRevolutCaptureResult = {
  success: boolean;
  status: string;
  capture_amount_pence: number;
  provider_order_id: string;
  message?: string;
  error?: string;
  shortfall_pence?: number;
};

export async function finalizeRevolutTripCapture(args: {
  supabase: SupabaseClient;
  trip: Record<string, unknown>;
  tipPence?: number;
}): Promise<FinalizeRevolutCaptureResult> {
  return executeRevolutTripCompletionCapture(args);
}
