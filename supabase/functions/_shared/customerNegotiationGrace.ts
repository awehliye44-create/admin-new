import { type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { negotiationExpiresAtIso, negotiationCountdownSeconds } from "./negotiation-deadline.ts";

/** Driver may accept standard/base fare briefly after an explicit customer decline. */
export const CUSTOMER_DECLINE_GRACE_SECONDS = negotiationCountdownSeconds;

export type CustomerGraceReason = "decline" | "timeout_customer";

/**
 * Customer explicitly rejected a preset — driver grace window before rematch.
 */
export async function applyCustomerDeclineGrace(
  supabase: SupabaseClient,
  params: {
    offer_id: string;
    trip_id: string;
    driver_id: string;
    reason: CustomerGraceReason;
  },
): Promise<{ grace_window_expires_at: string; negotiation_expires_at: string }> {
  const { data, error } = await supabase.rpc("apply_customer_decline_grace", {
    p_offer_id: params.offer_id,
    p_reason: params.reason,
  });

  if (error) {
    console.error("[customerNegotiationGrace] apply_customer_decline_grace RPC failed:", error);
    throw error;
  }

  const row = data as {
    grace_window_expires_at?: string;
    negotiation_expires_at?: string;
  } | null;

  const negotiationExpiresAt =
    row?.negotiation_expires_at
    ?? row?.grace_window_expires_at
    ?? negotiationExpiresAtIso();

  console.log("[customerNegotiationGrace] DRIVER_GRACE_NO_REBROADCAST", {
    trip_id: params.trip_id,
    offer_id: params.offer_id,
    driver_id: params.driver_id,
    reason: params.reason,
    negotiation_expires_at: negotiationExpiresAt,
  });

  return {
    grace_window_expires_at: row?.grace_window_expires_at ?? negotiationExpiresAt,
    negotiation_expires_at: negotiationExpiresAt,
  };
}
