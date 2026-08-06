/**
 * Revolut trip-modification authorisation — same-order increment first.
 * Controlled new-order top-up only when increment is definitively unsupported/limit-exceeded.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import { executeSameOrderIncrement } from "./executeSameOrderIncrementSSOT.ts";
import {
  getRevolutMerchantConfig,
  retrieveRevolutOrder,
  revolutProviderAuthorisedTotalPence,
  createRevolutOrder,
} from "./revolutOrders.ts";
import { INCREMENT_FEATURE_FLAG } from "./revolutIncrementAuthorisationSSOT.ts";

export type RevolutModAuthResult =
  | {
    ok: true;
    sufficient: true;
    authorised_amount_pence: number;
    payment_coverage_status: "authorized" | "authorization_sufficient";
    increment_used?: boolean;
  }
  | {
    ok: true;
    sufficient: false;
    provider: "revolut";
    provider_order_id: string;
    provider_checkout_token: string;
    revolut_public_key: string | null;
    authorised_amount_pence: number;
    target_amount_pence: number;
    top_up_amount_pence: number;
    error_code: "REVOLUT_AUTH_INSUFFICIENT" | "REVOLUT_INCREMENT_UNSUPPORTED";
    requires_revolut_checkout: true;
  }
  | {
    ok: false;
    error: string;
    error_code?: string;
    status?: number;
    payment_coverage_status?: string;
  };

async function isIncrementFeatureEnabled(supabase: SupabaseClient): Promise<boolean> {
  try {
    const { data } = await supabase
      .from("app_feature_flags")
      .select("enabled")
      .eq("key", INCREMENT_FEATURE_FLAG)
      .maybeSingle();
    if (data && typeof data.enabled === "boolean") return data.enabled;
  } catch {
    // table may not exist yet — default enabled for Phase A local/sandbox.
  }
  return true;
}

/**
 * Ensure authorised hold covers targetAuthorisedAmountPence for a trip modification.
 */
export async function prepareRevolutModificationAuthorisation(args: {
  supabase: SupabaseClient;
  trip: Record<string, unknown>;
  paymentSessionId?: string | null;
  targetAuthorisedAmountPence: number;
  updatedEstimatedTotalPence: number;
  fareRevisionNumber?: number;
  allowControlledFallback?: boolean;
}): Promise<RevolutModAuthResult> {
  const orderId = String(
    args.trip.provider_order_id ?? args.trip.stripe_payment_intent_id ?? "",
  ).trim();
  if (!orderId) {
    return { ok: false, error: "Trip has no Revolut order id", error_code: "MISSING_ORDER" };
  }

  const { secretKey, environment } = getRevolutMerchantConfig();
  const publicKey = Deno.env.get("REVOLUT_MERCHANT_PUBLIC_KEY") ?? null;
  const existingOrder = await retrieveRevolutOrder(environment, secretKey, orderId);
  const currentAuthPence = revolutProviderAuthorisedTotalPence(existingOrder);
  const target = Math.max(0, Math.round(Number(args.targetAuthorisedAmountPence)));

  if (target <= currentAuthPence) {
    return {
      ok: true,
      sufficient: true,
      authorised_amount_pence: currentAuthPence,
      payment_coverage_status: "authorization_sufficient",
    };
  }

  let sessionId = args.paymentSessionId ? String(args.paymentSessionId) : "";
  if (!sessionId) {
    const { data: sess } = await args.supabase
      .from("payment_sessions")
      .select("id")
      .eq("provider_order_id", orderId)
      .neq("purpose", "PAYMENT_RECOVERY")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    sessionId = sess?.id ? String(sess.id) : "";
  }
  if (!sessionId) {
    return {
      ok: false,
      error: "Payment session missing for same-order increment",
      error_code: "SESSION_NOT_FOUND",
      payment_coverage_status: "authorization_insufficient",
    };
  }

  const featureEnabled = await isIncrementFeatureEnabled(args.supabase);
  const incrementResult = await executeSameOrderIncrement({
    supabase: args.supabase,
    environment,
    secretKey,
    paymentSessionId: sessionId,
    providerOrderId: orderId,
    requiredTotalPence: target,
    currency: String(args.trip.currency_code ?? existingOrder.currency ?? "GBP"),
    source: "trip_modification",
    reason: "trip_modification_fare_increase",
    owner: `trip_mod:${String(args.trip.id)}:r${args.fareRevisionNumber ?? 0}`,
    featureEnabled,
  });

  if (incrementResult.ok) {
    console.log(JSON.stringify({
      event: "increment_trip_modification_applied",
      trip_id: args.trip.id,
      confirmed_total: incrementResult.providerConfirmedTotalPence,
      kind: incrementResult.kind,
    }));
    return {
      ok: true,
      sufficient: true,
      authorised_amount_pence: incrementResult.providerConfirmedTotalPence,
      payment_coverage_status: "authorization_sufficient",
      increment_used: incrementResult.kind !== "not_required",
    };
  }

  if (
    incrementResult.kind === "declined"
    || incrementResult.kind === "customer_action_required"
    || incrementResult.kind === "unknown"
    || incrementResult.kind === "retryable"
    || incrementResult.kind === "lock_busy"
  ) {
    // Fail closed — do not apply modification; do not create second order automatically.
    return {
      ok: false,
      error: incrementResult.message,
      error_code: incrementResult.errorClassification,
      status: incrementResult.kind === "declined" ? 402 : 409,
      payment_coverage_status: "authorization_insufficient",
    };
  }

  // unsupported / provider_limit / ineligible → controlled fallback only when explicitly allowed.
  if (args.allowControlledFallback !== true) {
    return {
      ok: false,
      error: incrementResult.message,
      error_code: incrementResult.errorClassification || "REVOLUT_INCREMENT_UNSUPPORTED",
      status: 409,
      payment_coverage_status: "authorization_insufficient",
    };
  }

  const topUp = target - currentAuthPence;
  const currency = String(args.trip.currency_code ?? existingOrder.currency ?? "GBP").toUpperCase();
  const newOrder = await createRevolutOrder({
    environment,
    secretKey,
    amountMinor: topUp,
    currency,
    tripId: String(args.trip.id),
    description: `ONECAB trip ${args.trip.id} modification top-up (controlled fallback)`,
    metadata: {
      type: "trip_modification_controlled_fallback",
      trip_id: String(args.trip.id),
      original_order_id: orderId,
      parent_payment_session_id: sessionId,
      target_total_pence: String(target),
    },
    enableIncrementalAuthorisation: false,
  });

  return {
    ok: true,
    sufficient: false,
    provider: "revolut",
    provider_order_id: newOrder.id,
    provider_checkout_token: newOrder.token ?? "",
    revolut_public_key: publicKey ?? null,
    authorised_amount_pence: currentAuthPence,
    target_amount_pence: target,
    top_up_amount_pence: topUp,
    error_code: "REVOLUT_INCREMENT_UNSUPPORTED",
    requires_revolut_checkout: true,
  };
}

/** @deprecated Prefer prepareRevolutModificationAuthorisation */
export const prepareRevolutModificationTopUp = prepareRevolutModificationAuthorisation;
