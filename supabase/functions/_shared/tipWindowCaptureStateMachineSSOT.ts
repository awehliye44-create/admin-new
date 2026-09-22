/**
 * Canonical tip-window capture sequence — pure state machine (SSOT).
 *
 * Trip completion is NOT a capture trigger. Only A/B/C/D may capture.
 * MK-260922-001: local capture_amount_pence / AUTHORISED must never invent captured.
 *
 * This module is the hard-rule contract. Wire call sites to it deliberately;
 * do not silently diverge.
 */

export const TIP_WINDOW_MS = 20 * 60 * 1000;

export type TipWindowPhase = "open" | "closed" | "expired_closed";

export type ProviderPaymentPhase =
  | "authorised"
  | "increment_pending"
  | "captured"
  | "declined_tip_auth";

export type LocalPaymentPhase = "authorised" | "captured";

export type TipWindowCaptureTrigger =
  | "CUSTOMER_SKIP"
  | "CUSTOMER_SUBMIT_NO_TIP"
  | "CUSTOMER_SUBMIT_WITH_TIP"
  | "WINDOW_EXPIRED";

/** Forbidden capture sources under the hard rule. */
export const FORBIDDEN_CAPTURE_SOURCES = [
  "trip_completion",
  "rating_screen_open",
  "app_resume",
  "webhook_alone",
] as const;

export type TipWindowMachineState = {
  tipWindow: TipWindowPhase;
  tipWindowOpenedAtMs: number | null;
  tipWindowExpiresAtMs: number | null;
  provider: ProviderPaymentPhase;
  localPayment: LocalPaymentPhase;
  farePence: number;
  tipPence: number;
  tipCreditPosted: boolean;
  tenPosted: boolean;
  captureCount: number;
  tipCreditCount: number;
  tenCount: number;
  lastTrigger: TipWindowCaptureTrigger | null;
  customerMessage: string | null;
};

export type TipWindowMachineEvent =
  | { type: "TRIP_COMPLETED"; atMs: number; farePence: number }
  | { type: "CUSTOMER_SKIP"; atMs: number }
  | { type: "CUSTOMER_SUBMIT_NO_TIP"; atMs: number }
  | { type: "CUSTOMER_SUBMIT_WITH_TIP"; atMs: number; tipPence: number; tipAuthOk: boolean }
  | { type: "WINDOW_EXPIRED_SWEEP"; atMs: number }
  | {
    type: "PROVIDER_CAPTURE_RESULT";
    providerCompleted: boolean;
    capturedPence: number;
  };

export function initialTipWindowMachineState(): TipWindowMachineState {
  return {
    tipWindow: "open",
    tipWindowOpenedAtMs: null,
    tipWindowExpiresAtMs: null,
    provider: "authorised",
    localPayment: "authorised",
    farePence: 0,
    tipPence: 0,
    tipCreditPosted: false,
    tenPosted: false,
    captureCount: 0,
    tipCreditCount: 0,
    tenCount: 0,
    lastTrigger: null,
    customerMessage: null,
  };
}

/** Completion stamps the window and may post TEN; never captures. */
export function onTripCompleted(
  state: TipWindowMachineState,
  atMs: number,
  farePence: number,
): TipWindowMachineState {
  const fare = Math.max(0, Math.round(farePence));
  return {
    ...state,
    tipWindow: "open",
    tipWindowOpenedAtMs: atMs,
    tipWindowExpiresAtMs: atMs + TIP_WINDOW_MS,
    provider: "authorised",
    localPayment: "authorised",
    farePence: fare,
    tipPence: 0,
    tipCreditPosted: false,
    tenPosted: fare > 0,
    tenCount: fare > 0 ? state.tenCount + 1 : state.tenCount,
    lastTrigger: null,
    customerMessage: null,
  };
}

export function isWindowOpen(state: TipWindowMachineState, atMs: number): boolean {
  if (state.tipWindow !== "open") return false;
  if (state.tipWindowExpiresAtMs == null) return false;
  return atMs < state.tipWindowExpiresAtMs;
}

/**
 * capture_amount_pence is never proof. Only provider COMPLETED/CAPTURED may
 * advance local payment to captured.
 */
export function mayStampLocalCaptured(args: {
  providerCompleted: boolean;
  captureAmountPence?: number | null;
}): boolean {
  if (!args.providerCompleted) return false;
  // Amount may be positive after confirm, but amount alone never grants the stamp.
  void args.captureAmountPence;
  return true;
}

export function resolveCaptureTrigger(args: {
  state: TipWindowMachineState;
  atMs: number;
  requested: TipWindowCaptureTrigger;
}): { ok: true; trigger: TipWindowCaptureTrigger } | { ok: false; reason: string } {
  const { state, atMs, requested } = args;
  if (state.localPayment === "captured" || state.provider === "captured") {
    return { ok: false, reason: "already_captured" };
  }
  if (state.tipWindow === "closed" || state.tipWindow === "expired_closed") {
    return { ok: false, reason: "window_already_closed" };
  }

  if (requested === "WINDOW_EXPIRED") {
    if (state.tipWindowExpiresAtMs == null) return { ok: false, reason: "no_window" };
    if (atMs < state.tipWindowExpiresAtMs) return { ok: false, reason: "window_still_open" };
    return { ok: true, trigger: "WINDOW_EXPIRED" };
  }

  if (!isWindowOpen(state, atMs)) {
    return { ok: false, reason: "window_not_open" };
  }
  return { ok: true, trigger: requested };
}

/**
 * Race: first valid claim wins. Skip/expiry → fare-only. Tip-submit wins over
 * expiry only while still unexpired. After expiry, tip-submit is refused.
 */
export function pickRaceWinner(args: {
  state: TipWindowMachineState;
  atMs: number;
  candidates: TipWindowCaptureTrigger[];
}): TipWindowCaptureTrigger | null {
  const ordered = [...args.candidates];
  // Deterministic priority when both are valid at the same instant:
  // customer decision (skip/submit) beats expiry; tip>0 beats tip=0/skip.
  const priority: Record<TipWindowCaptureTrigger, number> = {
    CUSTOMER_SUBMIT_WITH_TIP: 4,
    CUSTOMER_SUBMIT_NO_TIP: 3,
    CUSTOMER_SKIP: 2,
    WINDOW_EXPIRED: 1,
  };
  ordered.sort((a, b) => priority[b] - priority[a]);
  for (const requested of ordered) {
    const resolved = resolveCaptureTrigger({
      state: args.state,
      atMs: args.atMs,
      requested,
    });
    if (resolved.ok) return resolved.trigger;
  }
  return null;
}

function sealAfterConfirmedCapture(
  state: TipWindowMachineState,
  args: {
    trigger: TipWindowCaptureTrigger;
    tipPence: number;
    expired: boolean;
  },
): TipWindowMachineState {
  const tip = Math.max(0, Math.round(args.tipPence));
  return {
    ...state,
    tipWindow: args.expired ? "expired_closed" : "closed",
    provider: "captured",
    localPayment: "captured",
    tipPence: tip,
    tipCreditPosted: tip > 0,
    tipCreditCount: tip > 0 ? state.tipCreditCount + 1 : state.tipCreditCount,
    captureCount: state.captureCount + 1,
    lastTrigger: args.trigger,
    customerMessage: null,
  };
}

/**
 * Apply an authorised trigger. Tip-auth failure for WITH_TIP must not capture,
 * must not save tip, must not credit, must not close the window.
 */
export function applyCaptureTrigger(
  state: TipWindowMachineState,
  args: {
    atMs: number;
    trigger: TipWindowCaptureTrigger;
    tipPence?: number;
    tipAuthOk?: boolean;
    /** Simulated provider capture confirmation after the attempt. */
    providerCompleted: boolean;
  },
): TipWindowMachineState {
  const resolved = resolveCaptureTrigger({
    state,
    atMs: args.atMs,
    requested: args.trigger,
  });
  if (!resolved.ok) {
    return { ...state, customerMessage: resolved.reason };
  }

  if (args.trigger === "CUSTOMER_SUBMIT_WITH_TIP") {
    const tip = Math.max(0, Math.round(args.tipPence ?? 0));
    if (tip <= 0) {
      // Treat as no-tip submit.
      return applyCaptureTrigger(state, {
        ...args,
        trigger: "CUSTOMER_SUBMIT_NO_TIP",
        tipPence: 0,
      });
    }
    if (args.tipAuthOk === false) {
      return {
        ...state,
        provider: "declined_tip_auth",
        localPayment: "authorised",
        tipPence: 0,
        tipCreditPosted: false,
        lastTrigger: null,
        customerMessage: "bank_declined_tip",
      };
    }
    if (!args.providerCompleted) {
      return {
        ...state,
        localPayment: "authorised",
        provider: "authorised",
        customerMessage: "provider_capture_not_confirmed",
      };
    }
    if (!mayStampLocalCaptured({ providerCompleted: true })) {
      return state;
    }
    return sealAfterConfirmedCapture(state, {
      trigger: "CUSTOMER_SUBMIT_WITH_TIP",
      tipPence: tip,
      expired: false,
    });
  }

  // A / B / D — fare only
  if (!args.providerCompleted) {
    return {
      ...state,
      localPayment: "authorised",
      provider: "authorised",
      customerMessage: "provider_capture_not_confirmed",
    };
  }
  return sealAfterConfirmedCapture(state, {
    trigger: args.trigger,
    tipPence: 0,
    expired: args.trigger === "WINDOW_EXPIRED",
  });
}

/** Idempotent: a second trigger after capture must not double-capture / double-credit. */
export function applyTriggerIdempotent(
  state: TipWindowMachineState,
  args: Parameters<typeof applyCaptureTrigger>[1],
): TipWindowMachineState {
  if (state.localPayment === "captured" && state.provider === "captured") {
    return {
      ...state,
      customerMessage: "already_captured",
    };
  }
  return applyCaptureTrigger(state, args);
}
