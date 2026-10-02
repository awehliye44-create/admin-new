/**
 * P0 — Fast payment hold verification for trip commit.
 * Trusts payment_session authorised_hold + single Merchant API retrieve.
 * Webhook poll is fallback only for in-flight orders (≤2s).
 */

import { isAuthorisedHoldSessionStatus } from "./revolutPaymentHoldSSOT.ts";
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
import { isProviderReadAuthorisedVerifier } from "./bookingDirectFinalizeSSOT.ts";

const IN_FLIGHT_MAX_WAIT_MS = 2_000;
const IN_FLIGHT_POLL_MS = 200;

/** Max age of a same-request provider read that may stand in for CTAP's Revolut GET. */
export const FRESH_PROVIDER_READ_MAX_AGE_MS = 60_000;

export type FastRevolutHoldVerifyResult =
  | { ok: true; order: RevolutOrder; confirmed_via: "session" | "session_provider_read" | "api" | "webhook" }
  | { ok: false; order: RevolutOrder | null; reason: string };

/**
 * Order evidence from a payment session stamped by create-preauth / confirm right after they
 * read the Revolut order AUTHORISED with authorised total >= hold. Every invariant must hold,
 * otherwise the caller performs the Revolut GET. Writers never stamp these labels on a
 * card-save booking (save_card_eligible), so the synthesized metadata never skips token capture.
 */
export function freshProviderReadSessionOrder(
  session: Record<string, unknown> | null | undefined,
  args: { orderId: string; clientActionId?: string | null; userId?: string | null; nowMs?: number },
): { ok: true; order: RevolutOrder } | { ok: false; reason: string } {
  if (!session) return { ok: false, reason: "no_session" };
  if (!isProviderReadAuthorisedVerifier(session.provider_state_verified_by)) {
    return { ok: false, reason: "verifier_not_provider_read" };
  }
  if (String(session.provider_state ?? "").toUpperCase() !== "AUTHORISED") {
    return { ok: false, reason: "provider_state_not_authorised" };
  }
  if (!isAuthorisedHoldSessionStatus(String(session.status ?? ""))) {
    return { ok: false, reason: "session_not_authorised_hold" };
  }
  const verifiedAtMs = Date.parse(String(session.provider_state_verified_at ?? ""));
  const ageMs = (args.nowMs ?? Date.now()) - verifiedAtMs;
  if (!Number.isFinite(verifiedAtMs) || ageMs < 0 || ageMs > FRESH_PROVIDER_READ_MAX_AGE_MS) {
    return { ok: false, reason: "provider_read_stale" };
  }
  if (!args.orderId || String(session.provider_order_id ?? "") !== args.orderId) {
    return { ok: false, reason: "provider_order_mismatch" };
  }
  const clientActionId = String(args.clientActionId ?? "").trim();
  if (!clientActionId || String(session.client_action_id ?? "") !== clientActionId) {
    return { ok: false, reason: "client_action_mismatch" };
  }
  if (!args.userId || String(session.user_id ?? "") !== String(args.userId)) {
    return { ok: false, reason: "customer_mismatch" };
  }
  if (String(session.payment_provider ?? "").toLowerCase() !== "revolut") {
    return { ok: false, reason: "provider_mismatch" };
  }
  if (String(session.purpose ?? "RIDE_BOOKING") !== "RIDE_BOOKING") {
    return { ok: false, reason: "not_ride_booking" };
  }
  const platformPm = String(session.platform_payment_method_id ?? "").trim() || null;
  const authorised = Math.round(Number(session.authorised_amount_pence ?? 0));
  const payable = Math.round(Number(session.estimated_total_pence ?? 0));
  if (!Number.isFinite(authorised) || authorised <= 0 || !(payable > 0) || authorised < payable) {
    return { ok: false, reason: "authorised_below_payable" };
  }
  return {
    ok: true,
    order: {
      id: args.orderId,
      state: "AUTHORISED",
      amount: authorised,
      metadata: {
        client_action_id: clientActionId,
        customer_user_id: String(args.userId),
        ...(platformPm ? { platform_payment_method_id: platformPm } : {}),
        save_card_eligible: "false",
      },
    },
  };
}

export async function verifyRevolutHoldForTripCreateFast(
  supabase: SupabaseClient,
  args: {
    orderId: string;
    clientActionId?: string | null;
    environment?: ProviderEnvironment;
    preloadedSession?: Record<string, unknown> | null;
    /** Caller's auth user — required for the fresh provider-read fast path. */
    userId?: string | null;
  },
): Promise<FastRevolutHoldVerifyResult> {
  const session = args.preloadedSession !== undefined
    ? args.preloadedSession
    : (args.clientActionId
      ? await loadPaymentSession(supabase, { clientActionId: args.clientActionId })
      : null);
  const sessionStatus = String(session?.status ?? "");
  const sessionAuthorised = isAuthorisedHoldSessionStatus(sessionStatus);

  const fresh = freshProviderReadSessionOrder(session, {
    orderId: args.orderId,
    clientActionId: args.clientActionId,
    userId: args.userId,
  });
  if (fresh.ok) {
    return { ok: true, order: fresh.order, confirmed_via: "session_provider_read" };
  }

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
      { maxWaitMs: IN_FLIGHT_MAX_WAIT_MS, pollIntervalMs: IN_FLIGHT_POLL_MS, caller: "ctap_verify_fast" },
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
    { maxWaitMs: IN_FLIGHT_MAX_WAIT_MS, pollIntervalMs: IN_FLIGHT_POLL_MS, caller: "ctap_verify_fast" },
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
