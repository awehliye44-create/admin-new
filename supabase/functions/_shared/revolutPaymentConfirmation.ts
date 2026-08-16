/**
 * Revolut booking payment confirmation SSOT.
 * Webhook updates payment_authorization_ledger; API retrieve is the booking-time verifier.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import { markPaymentAuthorizationEvent } from "./dynamicPaymentWorkflow.ts";
import { buildPreauthIdempotencyKey } from "./dynamicPaymentWorkflow.ts";
import type { RevolutOrder } from "./revolutOrders.ts";
import { retrieveRevolutOrder } from "./revolutOrders.ts";
import type { ProviderEnvironment } from "./paymentProviders/types.ts";
import {
  handleRevolutPaymentInvariantViolation,
  isRevolutWrongCaptureBeforeTripComplete,
} from "./revolutPreauthReleaseSSOT.ts";

const AUTHORISED_STATES = new Set(["AUTHORISED", "COMPLETED"]);
/**
 * P0 — Trip create / confirm / CTAP may ONLY treat a true Revolut hold as paid.
 * PENDING/PROCESSING are in-flight checkout states — never trip-authorised.
 * COMPLETED (captured) is handled separately (invariant / capture paths).
 */
const BOOKING_PREAUTH_HOLD_STATES = new Set(["AUTHORISED"]);
const IN_FLIGHT_STATES = new Set(["PROCESSING", "PENDING"]);

export function isRevolutAuthorisedState(state: string | undefined): boolean {
  return AUTHORISED_STATES.has(String(state ?? "").toUpperCase());
}

/** True Revolut AUTHORISED hold only — never PENDING/PROCESSING. */
export function isRevolutBookingPreauthHoldState(state: string | undefined): boolean {
  return BOOKING_PREAUTH_HOLD_STATES.has(String(state ?? "").toUpperCase());
}

export function isRevolutInFlightState(state: string | undefined): boolean {
  return IN_FLIGHT_STATES.has(String(state ?? "").toUpperCase());
}

export async function isRevolutAuthLedgerConfirmed(
  supabase: SupabaseClient,
  orderId: string,
): Promise<boolean> {
  const { data } = await supabase
    .from("payment_authorization_ledger")
    .select("status")
    .eq("stripe_payment_intent_id", orderId)
    .eq("operation", "initial_auth")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return data?.status === "succeeded";
}

export async function markRevolutAuthLedgerConfirmed(
  supabase: SupabaseClient,
  args: {
    orderId: string;
    clientActionId?: string | null;
    tripId?: string | null;
    webhookEventId?: string | null;
  },
): Promise<void> {
  const idempotencyKey = buildPreauthIdempotencyKey({
    tripId: args.tripId ?? null,
    clientActionId: args.clientActionId ?? null,
  });

  if (idempotencyKey) {
    await markPaymentAuthorizationEvent(supabase, idempotencyKey, "succeeded", {
      provider: "revolut",
      provider_order_id: args.orderId,
      webhook_event_id: args.webhookEventId ?? null,
      confirmed_at: new Date().toISOString(),
    }).catch(() => undefined);
  }

  await supabase
    .from("payment_authorization_ledger")
    .update({
      status: "succeeded",
      updated_at: new Date().toISOString(),
      metadata: {
        provider: "revolut",
        provider_order_id: args.orderId,
        webhook_event_id: args.webhookEventId ?? null,
      },
    })
    .eq("stripe_payment_intent_id", args.orderId)
    .eq("operation", "initial_auth");
}

export async function markRevolutAuthLedgerFailed(
  supabase: SupabaseClient,
  args: {
    orderId: string;
    clientActionId?: string | null;
    orderState?: string | null;
    providerErrorMessage?: string | null;
    providerErrorType?: string | null;
    source?: string;
  },
): Promise<void> {
  const metadata = {
    provider: "revolut",
    provider_order_id: args.orderId,
    order_state: args.orderState ?? null,
    provider_error_type: args.providerErrorType ?? null,
    provider_error_message: args.providerErrorMessage ?? null,
    decline_recorded_at: new Date().toISOString(),
    source: args.source ?? "revolut-payment-decline",
  };

  const errorMessage =
    args.providerErrorMessage?.trim()
    || (args.orderState ? `Revolut order ${args.orderState}` : "Revolut payment declined");

  await supabase
    .from("payment_authorization_ledger")
    .update({
      status: "failed",
      error_message: errorMessage,
      metadata,
      updated_at: new Date().toISOString(),
    })
    .eq("stripe_payment_intent_id", args.orderId)
    .eq("operation", "initial_auth");

  if (args.clientActionId) {
    const idempotencyKey = buildPreauthIdempotencyKey({
      clientActionId: args.clientActionId,
    });
    await markPaymentAuthorizationEvent(supabase, idempotencyKey, "failed", metadata).catch(
      () => undefined,
    );
  }
}

export async function retrieveRevolutOrderWithRetry(
  environment: ProviderEnvironment,
  secretKey: string,
  orderId: string,
  options?: { maxAttempts?: number; delayMs?: number },
): Promise<RevolutOrder> {
  const maxAttempts = options?.maxAttempts ?? 8;
  const delayMs = options?.delayMs ?? 500;
  let last: RevolutOrder | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    last = await retrieveRevolutOrder(environment, secretKey, orderId);
    if (isRevolutAuthorisedState(last.state)) return last;
    if (!isRevolutInFlightState(last.state)) return last;
    if (attempt < maxAttempts) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  return last!;
}

export async function waitForRevolutWebhookAuthConfirmation(
  supabase: SupabaseClient,
  orderId: string,
  options?: { maxWaitMs?: number; pollIntervalMs?: number },
): Promise<boolean> {
  const maxWaitMs = options?.maxWaitMs ?? 15_000;
  const pollIntervalMs = options?.pollIntervalMs ?? 400;
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    if (await isRevolutAuthLedgerConfirmed(supabase, orderId)) {
      return true;
    }
    const { data: processed } = await supabase
      .from("processed_revolut_events")
      .select("id")
      .eq("order_id", orderId)
      .in("event_type", ["ORDER_AUTHORISED", "ORDER_PAYMENT_AUTHENTICATED"])
      .limit(1)
      .maybeSingle();
    if (processed?.id) return true;
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  return isRevolutAuthLedgerConfirmed(supabase, orderId);
}

export async function verifyRevolutOrderConfirmedForBooking(
  supabase: SupabaseClient,
  environment: ProviderEnvironment,
  secretKey: string,
  orderId: string,
  options?: { maxWaitMs?: number; pollIntervalMs?: number },
): Promise<{ ok: true; order: RevolutOrder; confirmed_via: "webhook" | "api" } | { ok: false; order: RevolutOrder | null; reason: string }> {
  const maxWaitMs = options?.maxWaitMs ?? 15_000;
  const pollIntervalMs = options?.pollIntervalMs ?? 400;
  const deadline = Date.now() + maxWaitMs;
  let lastOrder: RevolutOrder | null = null;

  // Checkout success usually means Revolut already authorised — avoid a long poll when one retrieve is enough.
  try {
    const immediate = await retrieveRevolutOrder(environment, secretKey, orderId);
    lastOrder = immediate;
    if (isRevolutWrongCaptureBeforeTripComplete(immediate.state)) {
      await handleRevolutPaymentInvariantViolation(supabase, {
        providerOrderId: orderId,
        clientActionId: immediate.metadata?.client_action_id ?? null,
        stage: "booking_payment_verify",
        reason: "captured_before_trip_completion",
        orderAmountPence: Number(immediate.amount ?? 0),
      });
      return {
        ok: false,
        order: immediate,
        reason: "Payment invariant violation: capture before trip completion",
      };
    }
    if (isRevolutBookingPreauthHoldState(immediate.state)) {
      await markRevolutAuthLedgerConfirmed(supabase, {
        orderId,
        clientActionId: immediate.metadata?.client_action_id ?? null,
      }).catch(() => undefined);
      return { ok: true, order: immediate, confirmed_via: "api" };
    }
    if (!isRevolutInFlightState(immediate.state)) {
      return {
        ok: false,
        order: immediate,
        reason: `Payment not authorized. Status: ${immediate.state ?? "unknown"}`,
      };
    }
  } catch {
    // Transient Merchant API error — fall through to webhook + poll loop.
  }

  while (Date.now() < deadline) {
    if (await isRevolutAuthLedgerConfirmed(supabase, orderId)) {
      const order = await retrieveRevolutOrder(environment, secretKey, orderId).catch(() => null);
      return { ok: true, order: order ?? { id: orderId, state: "AUTHORISED" }, confirmed_via: "webhook" };
    }

    const { data: processed } = await supabase
      .from("processed_revolut_events")
      .select("id")
      .eq("order_id", orderId)
      .in("event_type", ["ORDER_AUTHORISED", "ORDER_PAYMENT_AUTHENTICATED"])
      .limit(1)
      .maybeSingle();
    if (processed?.id) {
      const order = await retrieveRevolutOrder(environment, secretKey, orderId).catch(() => null);
      return { ok: true, order: order ?? { id: orderId, state: "AUTHORISED" }, confirmed_via: "webhook" };
    }

    try {
      lastOrder = await retrieveRevolutOrder(environment, secretKey, orderId);
      if (isRevolutWrongCaptureBeforeTripComplete(lastOrder.state)) {
        await handleRevolutPaymentInvariantViolation(supabase, {
          providerOrderId: orderId,
          clientActionId: lastOrder.metadata?.client_action_id ?? null,
          stage: "booking_payment_verify",
          reason: "captured_before_trip_completion",
          orderAmountPence: Number(lastOrder.amount ?? 0),
        });
        return {
          ok: false,
          order: lastOrder,
          reason: "Payment invariant violation: capture before trip completion",
        };
      }
      if (isRevolutBookingPreauthHoldState(lastOrder.state)) {
        await markRevolutAuthLedgerConfirmed(supabase, {
          orderId,
          clientActionId: lastOrder.metadata?.client_action_id ?? null,
        }).catch(() => undefined);
        return { ok: true, order: lastOrder, confirmed_via: "api" };
      }
      if (!isRevolutInFlightState(lastOrder.state)) {
        return {
          ok: false,
          order: lastOrder,
          reason: `Payment not authorized. Status: ${lastOrder.state ?? "unknown"}`,
        };
      }
    } catch {
      // Transient Merchant API error — keep polling until deadline.
    }

    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  // Book ticks send max_wait_ms: 0 — one retrieve already done above. Do not
  // double-hit Merchant API on every in-flight poll (nested latency).
  if (maxWaitMs <= 0 && lastOrder != null) {
    if (isRevolutInFlightState(lastOrder.state)) {
      return {
        ok: false,
        order: lastOrder,
        reason: "Payment is still processing. Please wait a moment and try again.",
      };
    }
    return {
      ok: false,
      order: lastOrder,
      reason: `Payment not authorized. Status: ${lastOrder.state ?? "unknown"}`,
    };
  }

  try {
    lastOrder = await retrieveRevolutOrder(environment, secretKey, orderId);
    if (isRevolutWrongCaptureBeforeTripComplete(lastOrder.state)) {
      await handleRevolutPaymentInvariantViolation(supabase, {
        providerOrderId: orderId,
        clientActionId: lastOrder.metadata?.client_action_id ?? null,
        stage: "booking_payment_verify",
        reason: "captured_before_trip_completion",
        orderAmountPence: Number(lastOrder.amount ?? 0),
      });
      return {
        ok: false,
        order: lastOrder,
        reason: "Payment invariant violation: capture before trip completion",
      };
    }
    if (isRevolutBookingPreauthHoldState(lastOrder.state)) {
      await markRevolutAuthLedgerConfirmed(supabase, {
        orderId,
        clientActionId: lastOrder.metadata?.client_action_id ?? null,
      }).catch(() => undefined);
      return { ok: true, order: lastOrder, confirmed_via: "api" };
    }
    if (isRevolutInFlightState(lastOrder.state)) {
      return {
        ok: false,
        order: lastOrder,
        reason: "Payment is still processing. Please wait a moment and try again.",
      };
    }
    return {
      ok: false,
      order: lastOrder,
      reason: `Payment not authorized. Status: ${lastOrder.state ?? "unknown"}`,
    };
  } catch {
    return {
      ok: false,
      order: lastOrder,
      reason: "Payment is still processing. Please wait a moment and try again.",
    };
  }
}
