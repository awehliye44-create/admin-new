/**
 * Wired tip-window capture orchestration (injectable deps for integration tests).
 *
 * Enforces:
 * - tip auth decline → zero capture calls, release claim, window OPEN
 * - confirmed capture → finalize CLOSED/EXPIRED once
 * - provider UNKNOWN → retain claim (no second owner)
 * - completion alone never captures
 */

import {
  TIP_AUTHORISATION_DECLINED,
  TIP_AUTHORISATION_DECLINED_CUSTOMER_MESSAGE,
  TIP_WINDOW_STATUS,
  TIP_WINDOW_TRIGGER,
  tipWindowTerminalStatusForTrigger,
  type TipWindowTrigger,
} from "./tipWindowConstants.ts";
import { classifyTipWindowCaptureOutcome } from "./tipWindowTriggerMutexSSOT.ts";
import { tipWindowCloseAllowedAfterFinalize } from "./tripPaymentFinalised.ts";

export type CaptureInvokeFn = (args: {
  tripId: string;
  tipPence: number;
  source: string;
}) => Promise<{
  ok: boolean;
  error?: string;
  body?: Record<string, unknown>;
  captureCallCount?: number;
}>;

export type MutexDeps = {
  claim: (args: {
    tripId: string;
    trigger: TipWindowTrigger;
    claimToken: string;
  }) => Promise<{ ok: true; claimToken: string } | { ok: false; code: string }>;
  release: (args: {
    tripId: string;
    claimToken: string;
    clearTip: boolean;
  }) => Promise<{ ok: boolean }>;
  finalize: (args: {
    tripId: string;
    claimToken: string;
    trigger: TipWindowTrigger;
    tipPence: number;
  }) => Promise<{ ok: boolean; tipWindowStatus?: string }>;
};

export type OrchestrationResult = {
  success: boolean;
  error_code?: string;
  error?: string;
  tip_amount_pence?: number;
  tip_window_status?: string;
  tip_window_trigger?: TipWindowTrigger;
  capture_calls: number;
  tip_rows_written: number;
  tip_credits: number;
  claim_retained: boolean;
  window_released: boolean;
};

const EMPTY: OrchestrationResult = {
  success: false,
  capture_calls: 0,
  tip_rows_written: 0,
  tip_credits: 0,
  claim_retained: false,
  window_released: false,
};

/**
 * Customer tip-window trigger (Skip / Submit no tip / Submit with tip).
 */
export async function runCustomerTipWindowTrigger(args: {
  tripId: string;
  trigger: TipWindowTrigger;
  tipPence: number;
  claimToken: string;
  mutex: MutexDeps;
  capture: CaptureInvokeFn;
  /** When tip credits / tip rows would be posted after confirmed tip capture. */
  onTipSettled?: (tipPence: number) => Promise<void> | void;
}): Promise<OrchestrationResult> {
  const tipPence = Math.max(0, Math.round(args.tipPence));
  if (
    args.trigger === TIP_WINDOW_TRIGGER.CUSTOMER_SUBMIT_WITH_TIP && tipPence <= 0
  ) {
    return {
      ...EMPTY,
      error_code: "INVALID_TIP",
      error: "tip required for CUSTOMER_SUBMIT_WITH_TIP",
    };
  }
  if (
    (args.trigger === TIP_WINDOW_TRIGGER.CUSTOMER_SKIP
      || args.trigger === TIP_WINDOW_TRIGGER.CUSTOMER_SUBMIT_NO_TIP)
    && tipPence > 0
  ) {
    return {
      ...EMPTY,
      error_code: "INVALID_TIP",
      error: "fare-only trigger cannot carry tip",
    };
  }

  const claimed = await args.mutex.claim({
    tripId: args.tripId,
    trigger: args.trigger,
    claimToken: args.claimToken,
  });
  if (!claimed.ok) {
    return {
      ...EMPTY,
      error_code: claimed.code,
      error: "Tip window claim denied",
    };
  }

  const rec = await args.capture({
    tripId: args.tripId,
    tipPence,
    source: "submit_customer_trip_tip",
  });
  const captureCalls = Math.max(1, Number(rec.captureCallCount ?? 1) || 1);
  const outcome = classifyTipWindowCaptureOutcome(rec.body);

  if (outcome.kind === "tip_authorisation_declined") {
    await args.mutex.release({
      tripId: args.tripId,
      claimToken: claimed.claimToken,
      clearTip: true,
    });
    return {
      success: false,
      error_code: TIP_AUTHORISATION_DECLINED,
      error: TIP_AUTHORISATION_DECLINED_CUSTOMER_MESSAGE,
      tip_amount_pence: 0,
      tip_window_status: TIP_WINDOW_STATUS.OPEN,
      capture_calls: Number(rec.captureCallCount ?? 0) || 0,
      tip_rows_written: 0,
      tip_credits: 0,
      claim_retained: false,
      window_released: true,
    };
  }

  if (outcome.kind === "provider_unknown") {
    return {
      success: false,
      error_code: "PROVIDER_UNKNOWN",
      error: rec.error ?? "Provider capture unknown — reconciling",
      capture_calls: captureCalls,
      tip_rows_written: 0,
      tip_credits: 0,
      claim_retained: true,
      window_released: false,
    };
  }

  if (
    !tipWindowCloseAllowedAfterFinalize(rec.body)
    || outcome.kind !== "capture_confirmed"
  ) {
    // Fare capture not confirmed — release so Skip / no-tip / retry / expiry can win.
    // EXCEPT: WITH_TIP that already declined is handled above.
    await args.mutex.release({
      tripId: args.tripId,
      claimToken: claimed.claimToken,
      clearTip: true,
    });
    return {
      success: false,
      error_code: "CAPTURE_FAILED",
      error: rec.error ?? "Capture failed",
      capture_calls: captureCalls,
      tip_rows_written: 0,
      tip_credits: 0,
      claim_retained: false,
      window_released: true,
    };
  }

  const collected = tipPence > 0
    ? Math.max(0, Math.round(Number(rec.body?.tip_collected_pence ?? tipPence) || 0))
    : 0;

  const fin = await args.mutex.finalize({
    tripId: args.tripId,
    claimToken: claimed.claimToken,
    trigger: args.trigger,
    tipPence: collected,
  });
  if (!fin.ok) {
    return {
      success: false,
      error_code: "CAPTURE_FAILED",
      error: "Tip captured but window close failed — retry",
      capture_calls: captureCalls,
      tip_rows_written: 0,
      tip_credits: 0,
      claim_retained: true,
      window_released: false,
    };
  }

  let tipCredits = 0;
  let tipRows = 0;
  if (collected > 0 && args.onTipSettled) {
    await args.onTipSettled(collected);
    tipCredits = 1;
    tipRows = 1;
  }

  return {
    success: true,
    tip_amount_pence: collected,
    tip_window_status: tipWindowTerminalStatusForTrigger(args.trigger),
    tip_window_trigger: args.trigger,
    capture_calls: captureCalls,
    tip_rows_written: tipRows,
    tip_credits: tipCredits,
    claim_retained: false,
    window_released: false,
  };
}

/** WINDOW_EXPIRED fare-only path. */
export async function runExpiredTipWindowTrigger(args: {
  tripId: string;
  claimToken: string;
  mutex: MutexDeps;
  capture: CaptureInvokeFn;
}): Promise<OrchestrationResult> {
  const claimed = await args.mutex.claim({
    tripId: args.tripId,
    trigger: TIP_WINDOW_TRIGGER.WINDOW_EXPIRED,
    claimToken: args.claimToken,
  });
  if (!claimed.ok) {
    return {
      ...EMPTY,
      error_code: claimed.code,
      error: "Expiry claim denied",
    };
  }

  const rec = await args.capture({
    tripId: args.tripId,
    tipPence: 0,
    source: "capture_expired_tip_windows",
  });
  const captureCalls = Math.max(1, Number(rec.captureCallCount ?? 1) || 1);
  const outcome = classifyTipWindowCaptureOutcome(rec.body);

  if (outcome.kind === "provider_unknown") {
    return {
      success: false,
      error_code: "PROVIDER_UNKNOWN",
      error: rec.error ?? "Provider capture unknown — reconciling",
      capture_calls: captureCalls,
      tip_rows_written: 0,
      tip_credits: 0,
      claim_retained: true,
      window_released: false,
    };
  }

  if (
    !tipWindowCloseAllowedAfterFinalize(rec.body)
    || outcome.kind !== "capture_confirmed"
  ) {
    // Retain claim on ambiguous failure so a racing customer trigger cannot
    // open a second capture while expiry is mid-flight; caller may release
    // after reconcile. For integration tests we retain.
    return {
      success: false,
      error_code: "CAPTURE_FAILED",
      error: rec.error ?? "Capture failed",
      capture_calls: captureCalls,
      tip_rows_written: 0,
      tip_credits: 0,
      claim_retained: true,
      window_released: false,
    };
  }

  const fin = await args.mutex.finalize({
    tripId: args.tripId,
    claimToken: claimed.claimToken,
    trigger: TIP_WINDOW_TRIGGER.WINDOW_EXPIRED,
    tipPence: 0,
  });

  return {
    success: fin.ok,
    tip_amount_pence: 0,
    tip_window_status: TIP_WINDOW_STATUS.EXPIRED,
    tip_window_trigger: TIP_WINDOW_TRIGGER.WINDOW_EXPIRED,
    capture_calls: captureCalls,
    tip_rows_written: 0,
    tip_credits: 0,
    claim_retained: !fin.ok,
    window_released: false,
    error_code: fin.ok ? undefined : "CAPTURE_FAILED",
  };
}

/** Completion is never a capture trigger. */
export function runTripCompletionTipWindowOpen(_args: {
  farePence: number;
}): OrchestrationResult {
  return {
    success: true,
    tip_amount_pence: 0,
    tip_window_status: TIP_WINDOW_STATUS.OPEN,
    capture_calls: 0,
    tip_rows_written: 0,
    tip_credits: 0,
    claim_retained: false,
    window_released: false,
  };
}
