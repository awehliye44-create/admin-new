/**
 * P0 — Fast payment hold verification for trip commit.
 * Trusts payment_session authorised_hold + single Merchant API retrieve.
 * Webhook poll is fallback only for in-flight orders (≤2s).
 */

import { isAuthorisedHoldSessionStatus } from "../../../shared/revolutPaymentHoldSSOT.ts";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import { loadPaymentSession } from "./paymentSessionSSOT.ts";
import { resolveRevolutMerchantContext } from "./revolutMerchantContext.ts";
import {
  isRevolutBookingPreauthHoldState,
  isRevolutInFlightState,
  verifyRevolutOrderConfirmedForBooking,
} from "./revolutPaymentConfirmation.ts";
import { retrieveRevolutOrder, type RevolutOrder } from "./revolutOrders.ts";
import type { ProviderEnvironment } from "./paymentProviders/types.ts";

const IN_FLIGHT_MAX_WAIT_MS = 2_000;
const IN_FLIGHT_POLL_MS = 200;

export type FastRevolutHoldVerifyResult =
  | { ok: true; order: RevolutOrder; confirmed_via: "session" | "api" | "webhook" }
  | { ok: false; order: RevolutOrder | null; reason: string };

export async function verifyRevolutHoldForTripCreateFast(
  supabase: SupabaseClient,
  args: {
    orderId: string;
    clientActionId?: string | null;
    environment?: ProviderEnvironment;
    preloadedSession?: Record<string, unknown> | null;
  },
): Promise<FastRevolutHoldVerifyResult> {
  const session = args.preloadedSession !== undefined
    ? args.preloadedSession
    : (args.clientActionId
      ? await loadPaymentSession(supabase, { clientActionId: args.clientActionId })
      : null);
  const sessionStatus = String(session?.status ?? "");
  const sessionAuthorised = isAuthorisedHoldSessionStatus(sessionStatus);

  const merchant = await resolveRevolutMerchantContext(
    supabase,
    args.environment ?? "live",
  );

  try {
    const immediate = await retrieveRevolutOrder(
      merchant.environment,
      merchant.secretKey,
      args.orderId,
    );
    if (isRevolutBookingPreauthHoldState(immediate.state)) {
      return {
        ok: true,
        order: immediate,
        confirmed_via: sessionAuthorised ? "session" : "api",
      };
    }
    if (!isRevolutInFlightState(immediate.state)) {
      return {
        ok: false,
        order: immediate,
        reason: `Payment not authorized. Status: ${immediate.state ?? "unknown"}`,
      };
    }
  } catch {
    if (sessionAuthorised) {
      return {
        ok: true,
        order: { id: args.orderId, state: "AUTHORISED" },
        confirmed_via: "session",
      };
    }
  }

  if (sessionAuthorised) {
    const shortPoll = await verifyRevolutOrderConfirmedForBooking(
      supabase,
      merchant.environment,
      merchant.secretKey,
      args.orderId,
      { maxWaitMs: IN_FLIGHT_MAX_WAIT_MS, pollIntervalMs: IN_FLIGHT_POLL_MS },
    );
    if (shortPoll.ok) {
      return {
        ok: true,
        order: shortPoll.order,
        confirmed_via: shortPoll.confirmed_via,
      };
    }
    return {
      ok: false,
      order: shortPoll.order,
      reason: shortPoll.reason,
    };
  }

  const polled = await verifyRevolutOrderConfirmedForBooking(
    supabase,
    merchant.environment,
    merchant.secretKey,
    args.orderId,
    { maxWaitMs: IN_FLIGHT_MAX_WAIT_MS, pollIntervalMs: IN_FLIGHT_POLL_MS },
  );
  if (polled.ok) {
    return {
      ok: true,
      order: polled.order,
      confirmed_via: polled.confirmed_via,
    };
  }
  return {
    ok: false,
    order: polled.order,
    reason: polled.reason,
  };
}
