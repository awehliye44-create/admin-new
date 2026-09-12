/**
 * Revolut trip capture at complete — delegates to hold reconciliation SSOT.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import { isTipWindowOpen } from "../../../shared/tripPaymentFinalised.ts";
import { executeRevolutTripCompletionCapture } from "./revolutCompletionCapture.ts";

export type FinalizeRevolutCaptureResult = {
  success: boolean;
  status: string;
  capture_amount_pence: number;
  provider_order_id: string;
  message?: string;
  error?: string;
  shortfall_pence?: number;
  tip_collected_pence?: number;
  tip_shortfall_pence?: number;
  provider_capture_status?: "CAPTURED";
  settlement_status?: "SUCCEEDED" | "FAILED";
  wallet_posting_status?: "SUCCEEDED" | "FAILED";
  reconciliation_status?: "BALANCED" | "WALLET_MISMATCH";
  retry_provider_capture?: false;
};

export async function finalizeRevolutTripCapture(args: {
  supabase: SupabaseClient;
  trip: Record<string, unknown>;
  tipPence?: number;
  /** Tip submit captures while window still open, then closes after success. */
  allowOpenTipWindow?: boolean;
}): Promise<FinalizeRevolutCaptureResult> {
  // Shared gate for HTTP finalize, admin remediate, and any in-process caller.
  // Tip submit may bypass while claiming; expiry runs after expires_at.
  if (
    !args.allowOpenTipWindow &&
    isTipWindowOpen({
      tip_window_expires_at: args.trip.tip_window_expires_at as string | null | undefined,
      tip_window_closed_at: args.trip.tip_window_closed_at as string | null | undefined,
      tip_window_status: args.trip.tip_window_status as string | null | undefined,
      completed_at: args.trip.completed_at as string | null | undefined,
    })
  ) {
    return {
      success: false,
      status: "tip_window_open",
      capture_amount_pence: 0,
      provider_order_id: String(args.trip.provider_order_id ?? args.trip.payment_intent_id ?? ""),
      error: "Tip window still open — capture deferred",
      message: "TIP_WINDOW_OPEN",
    };
  }

  return executeRevolutTripCompletionCapture(args);
}
