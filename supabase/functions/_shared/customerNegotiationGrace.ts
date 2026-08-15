import { type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { buildDriverNegotiationPushData } from "./driverNegotiationPush.ts";
import { resolveNegotiationBaseFarePence } from "./negotiationBaseFare.ts";
import {
  negotiationDeadlineIso,
  PRESET_COUNTDOWN_SECONDS_FALLBACK,
} from "./negotiation-deadline.ts";
import {
  CUSTOMER_DECLINED_OFFER_TITLE,
  customerDeclinedSecondChanceBody,
} from "./negotiationPushCopy.ts";

/**
 * Existing negotiation phase reused as Driver second chance at original £X.
 * Do not introduce a parallel waiting_driver_original_fare status.
 */
export const DRIVER_SECOND_CHANCE_PHASE = "declined_customer_awaiting_driver";

/**
 * Fallback only when apply_customer_decline_grace omits a deadline.
 * Not a second timer config — Admin countdown lives in the RPC.
 */
export const CUSTOMER_DECLINE_GRACE_SECONDS = PRESET_COUNTDOWN_SECONDS_FALLBACK;

export type CustomerGraceReason = "decline" | "timeout_customer";

export type DriverSecondChanceResult = {
  ok: boolean;
  already: boolean;
  grace_window_expires_at: string;
  negotiation_expires_at: string;
  original_fare_pence: number | null;
  error?: string;
};

/**
 * Customer did not accept Driver £Y → one Driver second chance at original £X.
 * Decline, ignore, and Customer countdown expiry MUST all call this helper.
 */
export async function applyCustomerDeclineGrace(
  supabase: SupabaseClient,
  params: {
    offer_id: string;
    trip_id: string;
    driver_id: string;
    reason: CustomerGraceReason;
  },
): Promise<{ grace_window_expires_at: string; negotiation_expires_at: string; already: boolean }> {
  const { data, error } = await supabase.rpc("apply_customer_decline_grace", {
    p_offer_id: params.offer_id,
    p_reason: params.reason,
  });

  if (error) {
    console.error("[customerNegotiationGrace] apply_customer_decline_grace RPC failed:", error);
    throw error;
  }

  const row = data as {
    success?: boolean;
    already?: boolean;
    error?: string;
    grace_window_expires_at?: string;
    negotiation_expires_at?: string;
  } | null;

  if (row?.success === false) {
    throw new Error(row.error ?? "apply_customer_decline_grace failed");
  }

  const negotiationExpiresAt =
    row?.negotiation_expires_at
    ?? row?.grace_window_expires_at
    ?? negotiationDeadlineIso(CUSTOMER_DECLINE_GRACE_SECONDS);

  console.log("[customerNegotiationGrace] DRIVER_SECOND_CHANCE_ORIGINAL_FARE", {
    trip_id: params.trip_id,
    offer_id: params.offer_id,
    driver_id: params.driver_id,
    reason: params.reason,
    already: row?.already === true,
    negotiation_expires_at: negotiationExpiresAt,
  });

  return {
    grace_window_expires_at: row?.grace_window_expires_at ?? negotiationExpiresAt,
    negotiation_expires_at: negotiationExpiresAt,
    already: row?.already === true,
  };
}

async function postDriverSecondChancePush(
  supabaseUrl: string,
  serviceKey: string,
  body: Record<string, unknown>,
): Promise<void> {
  const res = await fetch(`${supabaseUrl}/functions/v1/send-driver-notification`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${serviceKey}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  console.log("[customerNegotiationGrace] second_chance driver push", {
    http_status: res.status,
    body: text.slice(0, 240),
  });
}

/**
 * Canonical Customer-non-accept transition + one Driver second-chance alert.
 */
export async function enterDriverSecondChanceAtOriginalFare(
  supabase: SupabaseClient,
  params: {
    offer_id: string;
    trip_id: string;
    driver_id: string;
    reason: CustomerGraceReason;
    trip?: unknown;
    notify?: boolean;
  },
): Promise<DriverSecondChanceResult> {
  const grace = await applyCustomerDeclineGrace(supabase, {
    offer_id: params.offer_id,
    trip_id: params.trip_id,
    driver_id: params.driver_id,
    reason: params.reason,
  });
  let tripRow = params.trip;
  if (!tripRow) {
    const { data } = await supabase
      .from("trips")
      .select(
        "id, base_fare_pence, estimated_fare, fare, fare_breakdown, gross_fare_pence, offer_discount_pence, promotion_discount_pence, discount_pence, final_customer_fare_pence, final_fare_pence, estimated_total_pence, fare_snapshot_json",
      )
      .eq("id", params.trip_id)
      .maybeSingle();
    tripRow = data;
  }
  const originalFarePence = tripRow
    ? resolveNegotiationBaseFarePence(tripRow as never)
    : null;

  if (params.notify !== false && !grace.already) {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    if (supabaseUrl && serviceKey) {
      try {
        await postDriverSecondChancePush(supabaseUrl, serviceKey, {
          driverId: params.driver_id,
          type: "NEGOTIATION_UPDATE",
          title: CUSTOMER_DECLINED_OFFER_TITLE,
          body: customerDeclinedSecondChanceBody(originalFarePence ?? 0),
          data: buildDriverNegotiationPushData({
            offer_id: params.offer_id,
            trip_id: params.trip_id,
            negotiation_status: DRIVER_SECOND_CHANCE_PHASE,
            negotiation_expires_at: grace.negotiation_expires_at,
            expires_at: grace.negotiation_expires_at,
            notificationType: "customer_declined_offer",
            original_fare_pence: originalFarePence,
            action_required: true,
          }),
        });
      } catch (pushErr) {
        console.warn("[customerNegotiationGrace] second_chance push failed:", pushErr);
      }
    }
  }

  return {
    ok: true,
    already: grace.already,
    grace_window_expires_at: grace.grace_window_expires_at,
    negotiation_expires_at: grace.negotiation_expires_at,
    original_fare_pence: originalFarePence,
  };
}
