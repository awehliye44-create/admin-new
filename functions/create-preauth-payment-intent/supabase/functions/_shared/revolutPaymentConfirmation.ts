/**
 * Revolut booking payment confirmation SSOT.
 *
 * The Merchant API order read is the only authority for booking confirmation.
 * payment_authorization_ledger and processed_revolut_events are never read
 * here: the ledger is an audit trail derived from payment_sessions, and a
 * table row can never stand in for a provider read. A confirmed result always
 * carries the order object returned by the provider in a hold state.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import type { RevolutOrder } from "./revolutOrders.ts";
import { retrieveRevolutOrder } from "./revolutOrders.ts";
import type { ProviderEnvironment } from "./paymentProviders/types.ts";
import { isRevolutBookingPreauthHoldState } from "./revolutBookingHoldState.ts";
import {
  handleRevolutPaymentInvariantViolation,
  isRevolutWrongCaptureBeforeTripComplete,
} from "./revolutPreauthReleaseSSOT.ts";

const AUTHORISED_STATES = new Set(["AUTHORISED", "COMPLETED"]);
const IN_FLIGHT_STATES = new Set(["PROCESSING", "PENDING"]);

export function isRevolutAuthorisedState(state: string | undefined): boolean {
  return AUTHORISED_STATES.has(String(state ?? "").toUpperCase());
}

export { isRevolutBookingPreauthHoldState };

export function isRevolutInFlightState(state: string | undefined): boolean {
  return IN_FLIGHT_STATES.has(String(state ?? "").toUpperCase());
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

export type RevolutConfirmCheckPhase = "immediate" | "poll" | "final";

export type RevolutConfirmCheckOutcome =
  | "authorised"
  | "in_flight"
  | "not_authorised"
  | "invariant_violation"
  | "provider_error";

/** One provider GET. Order id and state only — never amounts, cards or tokens. */
export type RevolutConfirmCheckEvent = {
  event: "REVOLUT_CONFIRM_CHECK";
  request_id: string;
  caller: string;
  client_request_seq: number | null;
  order_id: string;
  check_no: number;
  phase: RevolutConfirmCheckPhase;
  request_started_at: string;
  check_started_at: string;
  check_offset_ms: number;
  provider_get_ms: number;
  provider_state: string | null;
  provider_http_status: number | null;
  outcome: RevolutConfirmCheckOutcome;
  max_wait_ms: number;
  deadline_remaining_ms: number;
  deadline_passed: boolean;
};

export type RevolutConfirmResolution =
  | "api_authorised"
  | "provider_not_authorised"
  | "invariant_violation"
  | "deadline_in_flight"
  | "deadline_provider_error";

export type RevolutConfirmResolvedEvent = {
  event: "REVOLUT_CONFIRM_RESOLVED";
  request_id: string;
  caller: string;
  client_request_seq: number | null;
  order_id: string;
  resolution: RevolutConfirmResolution;
  resolution_owner: "provider_api";
  checks: number;
  provider_errors: number;
  total_ms: number;
  max_wait_ms: number;
  poll_interval_ms: number;
  last_provider_state: string | null;
};

export type VerifyRevolutBookingOptions = {
  maxWaitMs?: number;
  pollIntervalMs?: number;
  /** Who is verifying — "confirm-revolut-payment", "ctap_verify_fast", … */
  caller?: string;
  /** Client tick number when the client sends one (older apps do not). */
  clientRequestSeq?: number | null;
};

export type VerifyRevolutBookingDeps = {
  retrieve?: typeof retrieveRevolutOrder;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  emit?: (event: RevolutConfirmCheckEvent | RevolutConfirmResolvedEvent) => void;
  onInvariantViolation?: typeof handleRevolutPaymentInvariantViolation;
};

export type VerifyRevolutBookingResult =
  | { ok: true; order: RevolutOrder; confirmed_via: "api" }
  | { ok: false; order: RevolutOrder | null; reason: string };

const STILL_PROCESSING_REASON = "Payment is still processing. Please wait a moment and try again.";

function providerHttpStatus(err: unknown): number | null {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === "number" && Number.isFinite(status) ? status : null;
}

function defaultEmit(event: RevolutConfirmCheckEvent | RevolutConfirmResolvedEvent): void {
  console.info(JSON.stringify(event));
}

export async function verifyRevolutOrderConfirmedForBooking(
  supabase: SupabaseClient,
  environment: ProviderEnvironment,
  secretKey: string,
  orderId: string,
  options?: VerifyRevolutBookingOptions,
  deps?: VerifyRevolutBookingDeps,
): Promise<VerifyRevolutBookingResult> {
  const retrieve = deps?.retrieve ?? retrieveRevolutOrder;
  const now = deps?.now ?? Date.now;
  const sleep = deps?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const emit = deps?.emit ?? defaultEmit;
  const onInvariantViolation = deps?.onInvariantViolation ?? handleRevolutPaymentInvariantViolation;

  const maxWaitMs = Math.max(0, options?.maxWaitMs ?? 15_000);
  const pollIntervalMs = Math.max(0, options?.pollIntervalMs ?? 400);
  const caller = options?.caller ?? "unspecified";
  const clientRequestSeq = options?.clientRequestSeq ?? null;
  const requestId = crypto.randomUUID().slice(0, 12);
  const requestStartedAt = now();
  const deadline = requestStartedAt + maxWaitMs;

  let lastOrder: RevolutOrder | null = null;
  let checks = 0;
  let providerErrors = 0;
  let lastCheckSucceeded = false;
  let lastCheckEndedAt = requestStartedAt;

  const resolve = (resolution: RevolutConfirmResolution, result: VerifyRevolutBookingResult) => {
    emit({
      event: "REVOLUT_CONFIRM_RESOLVED",
      request_id: requestId,
      caller,
      client_request_seq: clientRequestSeq,
      order_id: orderId,
      resolution,
      resolution_owner: "provider_api",
      checks,
      provider_errors: providerErrors,
      total_ms: Math.max(0, now() - requestStartedAt),
      max_wait_ms: maxWaitMs,
      poll_interval_ms: pollIntervalMs,
      last_provider_state: lastOrder?.state ?? null,
    });
    return result;
  };

  /** One provider GET. Returns a terminal result, or null to keep waiting. */
  const check = async (phase: RevolutConfirmCheckPhase): Promise<VerifyRevolutBookingResult | null> => {
    checks += 1;
    const checkNo = checks;
    const started = now();
    const record = (
      outcome: RevolutConfirmCheckOutcome,
      state: string | null,
      httpStatus: number | null,
    ) => {
      const ended = now();
      lastCheckEndedAt = ended;
      emit({
        event: "REVOLUT_CONFIRM_CHECK",
        request_id: requestId,
        caller,
        client_request_seq: clientRequestSeq,
        order_id: orderId,
        check_no: checkNo,
        phase,
        request_started_at: new Date(requestStartedAt).toISOString(),
        check_started_at: new Date(started).toISOString(),
        check_offset_ms: Math.max(0, started - requestStartedAt),
        provider_get_ms: Math.max(0, ended - started),
        provider_state: state,
        provider_http_status: httpStatus,
        outcome,
        max_wait_ms: maxWaitMs,
        deadline_remaining_ms: deadline - ended,
        deadline_passed: ended >= deadline,
      });
    };

    let order: RevolutOrder;
    try {
      order = await retrieve(environment, secretKey, orderId);
    } catch (err) {
      providerErrors += 1;
      lastCheckSucceeded = false;
      record("provider_error", null, providerHttpStatus(err));
      return null;
    }
    lastOrder = order;
    lastCheckSucceeded = true;
    const state = order.state ?? null;

    if (isRevolutWrongCaptureBeforeTripComplete(order.state)) {
      record("invariant_violation", state, null);
      await onInvariantViolation(supabase, {
        providerOrderId: orderId,
        clientActionId: order.metadata?.client_action_id ?? null,
        stage: "booking_payment_verify",
        reason: "captured_before_trip_completion",
        orderAmountPence: Number(order.amount ?? 0),
      });
      return resolve("invariant_violation", {
        ok: false,
        order,
        reason: "Payment invariant violation: capture before trip completion",
      });
    }
    if (isRevolutBookingPreauthHoldState(order.state)) {
      record("authorised", state, null);
      return resolve("api_authorised", { ok: true, order, confirmed_via: "api" });
    }
    if (!isRevolutInFlightState(order.state)) {
      record("not_authorised", state, null);
      return resolve("provider_not_authorised", {
        ok: false,
        order,
        reason: `Payment not authorized. Status: ${order.state ?? "unknown"}`,
      });
    }
    record("in_flight", state, null);
    return null;
  };

  // Checkout success usually means Revolut already authorised — one read is often enough.
  const immediate = await check("immediate");
  if (immediate) return immediate;

  // Book ticks send max_wait_ms: 0 — one retrieve already done above. Do not
  // double-hit Merchant API on every in-flight poll (nested latency).
  if (maxWaitMs <= 0 && lastOrder != null) {
    return resolve("deadline_in_flight", {
      ok: false,
      order: lastOrder,
      reason: isRevolutInFlightState((lastOrder as RevolutOrder).state)
        ? STILL_PROCESSING_REASON
        : `Payment not authorized. Status: ${(lastOrder as RevolutOrder).state ?? "unknown"}`,
    });
  }

  // Sequential provider reads, paced by pollIntervalMs. The last sleep is cut
  // to the deadline so the final read lands on it instead of after it.
  while (now() < deadline) {
    const remaining = deadline - now();
    await sleep(Math.max(0, Math.min(pollIntervalMs, remaining)));
    const result = await check("poll");
    if (result) return result;
  }

  // One more read only when the last read failed or ended before the deadline.
  if (!lastCheckSucceeded || lastCheckEndedAt < deadline) {
    const result = await check("final");
    if (result) return result;
  }

  if (lastOrder == null) {
    return resolve("deadline_provider_error", {
      ok: false,
      order: null,
      reason: STILL_PROCESSING_REASON,
    });
  }
  return resolve("deadline_in_flight", {
    ok: false,
    order: lastOrder,
    reason: STILL_PROCESSING_REASON,
  });
}
