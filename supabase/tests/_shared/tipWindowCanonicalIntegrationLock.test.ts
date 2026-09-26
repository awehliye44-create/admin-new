/**
 * Wired tip-window capture integration tests (injectable orchestration deps).
 * Covers mandatory scenarios 1–12 from the canonical tip-window hard rule.
 */

import {
  assertEquals,
  assert,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  TIP_AUTHORISATION_DECLINED,
  TIP_AUTHORISATION_DECLINED_CUSTOMER_MESSAGE,
  TIP_NOT_COLLECTED,
  TIP_NOT_COLLECTED_CUSTOMER_MESSAGE,
  TIP_WINDOW_STATUS,
  TIP_WINDOW_TRIGGER,
} from "../../functions/_shared/tipWindowConstants.ts";
import {
  runCustomerTipWindowTrigger,
  runExpiredTipWindowTrigger,
  runTripCompletionTipWindowOpen,
  type CaptureInvokeFn,
  type MutexDeps,
} from "../../functions/_shared/tipWindowCaptureOrchestrationSSOT.ts";
import { tipWindowCloseAllowedAfterFinalize } from "../../functions/_shared/tripPaymentFinalised.ts";

type MemTrip = {
  status: string;
  trigger: string | null;
  claimToken: string | null;
  tipPence: number;
  captureCalls: number;
  tipRows: number;
  tipCredits: number;
  tenCount: number;
};

function memoryMutex(trip: MemTrip): MutexDeps {
  return {
    claim: async ({ trigger, claimToken }) => {
      if (
        trip.status === TIP_WINDOW_STATUS.CLOSED
        || trip.status === TIP_WINDOW_STATUS.EXPIRED
      ) {
        return { ok: false, code: "ALREADY_CLOSED" };
      }
      if (
        trip.status === TIP_WINDOW_STATUS.PROCESSING
        && trip.claimToken
        && trip.claimToken !== claimToken
      ) {
        return { ok: false, code: "CLAIM_HELD" };
      }
      trip.status = TIP_WINDOW_STATUS.PROCESSING;
      trip.trigger = trigger;
      trip.claimToken = claimToken;
      return { ok: true, claimToken };
    },
    release: async ({ claimToken, clearTip }) => {
      if (trip.claimToken !== claimToken) return { ok: false };
      trip.status = TIP_WINDOW_STATUS.OPEN;
      trip.trigger = null;
      trip.claimToken = null;
      if (clearTip) trip.tipPence = 0;
      return { ok: true };
    },
    finalize: async ({ claimToken, trigger, tipPence }) => {
      if (trip.claimToken !== claimToken) return { ok: false };
      trip.status = trigger === TIP_WINDOW_TRIGGER.WINDOW_EXPIRED
        ? TIP_WINDOW_STATUS.EXPIRED
        : TIP_WINDOW_STATUS.CLOSED;
      trip.trigger = trigger;
      trip.tipPence = tipPence;
      trip.claimToken = null;
      return { ok: true, tipWindowStatus: trip.status };
    },
    closeAfterFareCapture: async ({ tipPence }) => {
      trip.status = TIP_WINDOW_STATUS.CLOSED;
      trip.trigger = null;
      trip.claimToken = null;
      trip.tipPence = Math.max(0, Math.round(tipPence ?? 0));
      return { ok: true };
    },
  };
}

function captureRecorder(opts: {
  bodies: Array<Record<string, unknown>>;
  captureOnCall?: boolean[];
}): { fn: CaptureInvokeFn; calls: number; capturePosts: number } {
  const state = { calls: 0, capturePosts: 0 };
  const fn: CaptureInvokeFn = async () => {
    const idx = state.calls;
    state.calls += 1;
    const body = opts.bodies[Math.min(idx, opts.bodies.length - 1)] ?? {};
    const doCapture = opts.captureOnCall?.[idx] ?? (
      tipWindowCloseAllowedAfterFinalize(body)
    );
    if (doCapture) state.capturePosts += 1;
    return {
      ok: body.success !== false,
      body,
      captureCallCount: doCapture ? 1 : 0,
    };
  };
  return { fn, ...state, get calls() { return state.calls; }, get capturePosts() { return state.capturePosts; } };
}

Deno.test("1. Tip increment decline produces zero capture calls", async () => {
  const trip: MemTrip = {
    status: TIP_WINDOW_STATUS.OPEN,
    trigger: null,
    claimToken: null,
    tipPence: 0,
    captureCalls: 0,
    tipRows: 0,
    tipCredits: 0,
    tenCount: 1,
  };
  const cap = captureRecorder({
    bodies: [{
      success: false,
      status: "TIP_AUTHORISATION_DECLINED",
      error_code: "TIP_AUTHORISATION_DECLINED",
      capture_amount_pence: 0,
      provider_state: "AUTHORISED",
    }],
    captureOnCall: [false],
  });
  const result = await runCustomerTipWindowTrigger({
    tripId: "t1",
    trigger: TIP_WINDOW_TRIGGER.CUSTOMER_SUBMIT_WITH_TIP,
    tipPence: 200,
    claimToken: "tok-1",
    mutex: memoryMutex(trip),
    capture: cap.fn,
  });
  assertEquals(result.error_code, TIP_AUTHORISATION_DECLINED);
  assertEquals(result.capture_calls, 0);
  assertEquals(cap.capturePosts, 0);
});

Deno.test("2. Decline leaves window OPEN before deadline", async () => {
  const trip: MemTrip = {
    status: TIP_WINDOW_STATUS.OPEN,
    trigger: null,
    claimToken: null,
    tipPence: 0,
    captureCalls: 0,
    tipRows: 0,
    tipCredits: 0,
    tenCount: 1,
  };
  const result = await runCustomerTipWindowTrigger({
    tripId: "t1",
    trigger: TIP_WINDOW_TRIGGER.CUSTOMER_SUBMIT_WITH_TIP,
    tipPence: 100,
    claimToken: "tok-2",
    mutex: memoryMutex(trip),
    capture: async () => ({
      ok: false,
      body: {
        success: false,
        status: TIP_AUTHORISATION_DECLINED,
        capture_amount_pence: 0,
      },
      captureCallCount: 0,
    }),
  });
  assertEquals(result.window_released, true);
  assertEquals(result.tip_window_status, TIP_WINDOW_STATUS.OPEN);
  assertEquals(trip.status, TIP_WINDOW_STATUS.OPEN);
  assertEquals(trip.claimToken, null);
});

Deno.test("3. Decline creates zero tip rows and zero tip credits", async () => {
  const trip: MemTrip = {
    status: TIP_WINDOW_STATUS.OPEN,
    trigger: null,
    claimToken: null,
    tipPence: 0,
    captureCalls: 0,
    tipRows: 0,
    tipCredits: 0,
    tenCount: 1,
  };
  let settled = 0;
  const result = await runCustomerTipWindowTrigger({
    tripId: "t1",
    trigger: TIP_WINDOW_TRIGGER.CUSTOMER_SUBMIT_WITH_TIP,
    tipPence: 300,
    claimToken: "tok-3",
    mutex: memoryMutex(trip),
    capture: async () => ({
      ok: false,
      body: { success: false, status: TIP_AUTHORISATION_DECLINED, capture_amount_pence: 0 },
      captureCallCount: 0,
    }),
    onTipSettled: () => {
      settled += 1;
    },
  });
  assertEquals(result.tip_rows_written, 0);
  assertEquals(result.tip_credits, 0);
  assertEquals(settled, 0);
  assertEquals(trip.tipPence, 0);
});

Deno.test("4. Retry with successful tip captures fare+tip once", async () => {
  const trip: MemTrip = {
    status: TIP_WINDOW_STATUS.OPEN,
    trigger: null,
    claimToken: null,
    tipPence: 0,
    captureCalls: 0,
    tipRows: 0,
    tipCredits: 0,
    tenCount: 1,
  };
  const mutex = memoryMutex(trip);
  // Decline first
  await runCustomerTipWindowTrigger({
    tripId: "t1",
    trigger: TIP_WINDOW_TRIGGER.CUSTOMER_SUBMIT_WITH_TIP,
    tipPence: 200,
    claimToken: "tok-4a",
    mutex,
    capture: async () => ({
      ok: false,
      body: { success: false, status: TIP_AUTHORISATION_DECLINED, capture_amount_pence: 0 },
      captureCallCount: 0,
    }),
  });
  assertEquals(trip.status, TIP_WINDOW_STATUS.OPEN);

  let tipCredits = 0;
  const ok = await runCustomerTipWindowTrigger({
    tripId: "t1",
    trigger: TIP_WINDOW_TRIGGER.CUSTOMER_SUBMIT_WITH_TIP,
    tipPence: 200,
    claimToken: "tok-4b",
    mutex,
    capture: async () => ({
      ok: true,
      body: {
        success: true,
        status: "captured",
        capture_amount_pence: 700,
        tip_collected_pence: 200,
        provider_state: "COMPLETED",
      },
      captureCallCount: 1,
    }),
    onTipSettled: () => {
      tipCredits += 1;
    },
  });
  assertEquals(ok.success, true);
  assertEquals(ok.capture_calls, 1);
  assertEquals(ok.tip_amount_pence, 200);
  assertEquals(tipCredits, 1);
  assertEquals(trip.status, TIP_WINDOW_STATUS.CLOSED);
  assertEquals(trip.trigger, TIP_WINDOW_TRIGGER.CUSTOMER_SUBMIT_WITH_TIP);
});

Deno.test("5. Submit without tip after decline captures fare once", async () => {
  const trip: MemTrip = {
    status: TIP_WINDOW_STATUS.OPEN,
    trigger: null,
    claimToken: null,
    tipPence: 0,
    captureCalls: 0,
    tipRows: 0,
    tipCredits: 0,
    tenCount: 1,
  };
  const mutex = memoryMutex(trip);
  await runCustomerTipWindowTrigger({
    tripId: "t1",
    trigger: TIP_WINDOW_TRIGGER.CUSTOMER_SUBMIT_WITH_TIP,
    tipPence: 100,
    claimToken: "a",
    mutex,
    capture: async () => ({
      ok: false,
      body: { success: false, status: TIP_AUTHORISATION_DECLINED, capture_amount_pence: 0 },
      captureCallCount: 0,
    }),
  });
  const ok = await runCustomerTipWindowTrigger({
    tripId: "t1",
    trigger: TIP_WINDOW_TRIGGER.CUSTOMER_SUBMIT_NO_TIP,
    tipPence: 0,
    claimToken: "b",
    mutex,
    capture: async () => ({
      ok: true,
      body: {
        success: true,
        status: "captured",
        capture_amount_pence: 500,
        tip_collected_pence: 0,
        provider_state: "COMPLETED",
      },
      captureCallCount: 1,
    }),
  });
  assertEquals(ok.success, true);
  assertEquals(ok.capture_calls, 1);
  assertEquals(ok.tip_amount_pence, 0);
  assertEquals(trip.trigger, TIP_WINDOW_TRIGGER.CUSTOMER_SUBMIT_NO_TIP);
});

Deno.test("6. Skip after decline captures fare once", async () => {
  const trip: MemTrip = {
    status: TIP_WINDOW_STATUS.OPEN,
    trigger: null,
    claimToken: null,
    tipPence: 0,
    captureCalls: 0,
    tipRows: 0,
    tipCredits: 0,
    tenCount: 1,
  };
  const mutex = memoryMutex(trip);
  await runCustomerTipWindowTrigger({
    tripId: "t1",
    trigger: TIP_WINDOW_TRIGGER.CUSTOMER_SUBMIT_WITH_TIP,
    tipPence: 100,
    claimToken: "a",
    mutex,
    capture: async () => ({
      ok: false,
      body: { success: false, status: TIP_AUTHORISATION_DECLINED, capture_amount_pence: 0 },
      captureCallCount: 0,
    }),
  });
  const ok = await runCustomerTipWindowTrigger({
    tripId: "t1",
    trigger: TIP_WINDOW_TRIGGER.CUSTOMER_SKIP,
    tipPence: 0,
    claimToken: "b",
    mutex,
    capture: async () => ({
      ok: true,
      body: {
        success: true,
        status: "captured",
        capture_amount_pence: 500,
        provider_state: "CAPTURED",
      },
      captureCallCount: 1,
    }),
  });
  assertEquals(ok.success, true);
  assertEquals(ok.capture_calls, 1);
  assertEquals(trip.trigger, TIP_WINDOW_TRIGGER.CUSTOMER_SKIP);
});

Deno.test("7. Expiry after decline captures fare once and records EXPIRED", async () => {
  const trip: MemTrip = {
    status: TIP_WINDOW_STATUS.OPEN,
    trigger: null,
    claimToken: null,
    tipPence: 0,
    captureCalls: 0,
    tipRows: 0,
    tipCredits: 0,
    tenCount: 1,
  };
  const mutex = memoryMutex(trip);
  await runCustomerTipWindowTrigger({
    tripId: "t1",
    trigger: TIP_WINDOW_TRIGGER.CUSTOMER_SUBMIT_WITH_TIP,
    tipPence: 100,
    claimToken: "a",
    mutex,
    capture: async () => ({
      ok: false,
      body: { success: false, status: TIP_AUTHORISATION_DECLINED, capture_amount_pence: 0 },
      captureCallCount: 0,
    }),
  });
  const ok = await runExpiredTipWindowTrigger({
    tripId: "t1",
    claimToken: "exp",
    mutex,
    capture: async () => ({
      ok: true,
      body: {
        success: true,
        status: "captured",
        capture_amount_pence: 500,
        provider_state: "COMPLETED",
      },
      captureCallCount: 1,
    }),
  });
  assertEquals(ok.success, true);
  assertEquals(ok.tip_window_status, TIP_WINDOW_STATUS.EXPIRED);
  assertEquals(trip.status, TIP_WINDOW_STATUS.EXPIRED);
  assertEquals(trip.trigger, TIP_WINDOW_TRIGGER.WINDOW_EXPIRED);
});

Deno.test("8. Tip submit and expiry concurrency creates one provider capture", async () => {
  const trip: MemTrip = {
    status: TIP_WINDOW_STATUS.OPEN,
    trigger: null,
    claimToken: null,
    tipPence: 0,
    captureCalls: 0,
    tipRows: 0,
    tipCredits: 0,
    tenCount: 1,
  };
  const mutex = memoryMutex(trip);
  let capturePosts = 0;
  const capture: CaptureInvokeFn = async () => {
    capturePosts += 1;
    return {
      ok: true,
      body: {
        success: true,
        status: "captured",
        capture_amount_pence: 500,
        tip_collected_pence: 100,
        provider_state: "COMPLETED",
      },
      captureCallCount: 1,
    };
  };

  const tipPromise = runCustomerTipWindowTrigger({
    tripId: "t1",
    trigger: TIP_WINDOW_TRIGGER.CUSTOMER_SUBMIT_WITH_TIP,
    tipPence: 100,
    claimToken: "cust",
    mutex,
    capture,
  });
  const expPromise = runExpiredTipWindowTrigger({
    tripId: "t1",
    claimToken: "exp",
    mutex,
    capture,
  });
  const [tipRes, expRes] = await Promise.all([tipPromise, expPromise]);
  const winners = [tipRes, expRes].filter((r) => r.success);
  assertEquals(winners.length, 1);
  assertEquals(capturePosts, 1);
});

Deno.test("9. Provider AUTHORISED response cannot close the window", async () => {
  const trip: MemTrip = {
    status: TIP_WINDOW_STATUS.OPEN,
    trigger: null,
    claimToken: null,
    tipPence: 0,
    captureCalls: 0,
    tipRows: 0,
    tipCredits: 0,
    tenCount: 1,
  };
  const result = await runCustomerTipWindowTrigger({
    tripId: "t1",
    trigger: TIP_WINDOW_TRIGGER.CUSTOMER_SKIP,
    tipPence: 0,
    claimToken: "tok",
    mutex: memoryMutex(trip),
    capture: async () => ({
      ok: true,
      body: {
        success: true,
        status: "authorized",
        capture_amount_pence: 500,
        provider_state: "AUTHORISED",
      },
      captureCallCount: 0,
    }),
  });
  assertEquals(result.success, false);
  assertEquals(trip.status, TIP_WINDOW_STATUS.OPEN);
  assertEquals(
    tipWindowCloseAllowedAfterFinalize({
      success: true,
      status: "authorized",
      capture_amount_pence: 500,
      provider_state: "AUTHORISED",
    }),
    false,
  );
});

Deno.test("10. Provider UNKNOWN cannot allow another trigger", async () => {
  const trip: MemTrip = {
    status: TIP_WINDOW_STATUS.OPEN,
    trigger: null,
    claimToken: null,
    tipPence: 0,
    captureCalls: 0,
    tipRows: 0,
    tipCredits: 0,
    tenCount: 1,
  };
  const mutex = memoryMutex(trip);
  const unknown = await runCustomerTipWindowTrigger({
    tripId: "t1",
    trigger: TIP_WINDOW_TRIGGER.CUSTOMER_SKIP,
    tipPence: 0,
    claimToken: "owner",
    mutex,
    capture: async () => ({
      ok: false,
      body: {
        success: false,
        status: "CAPTURE_UNKNOWN",
        capture_amount_pence: 0,
        provider_state: "UNKNOWN",
      },
      captureCallCount: 1,
    }),
  });
  assertEquals(unknown.claim_retained, true);
  assertEquals(trip.status, TIP_WINDOW_STATUS.PROCESSING);

  const raced = await runExpiredTipWindowTrigger({
    tripId: "t1",
    claimToken: "other",
    mutex,
    capture: async () => {
      throw new Error("must not capture");
    },
  });
  assertEquals(raced.success, false);
  assertEquals(raced.error_code, "CLAIM_HELD");
  assertEquals(trip.status, TIP_WINDOW_STATUS.PROCESSING);
});

Deno.test("11. Duplicate callback creates no duplicate TEN or tip credit", async () => {
  const trip: MemTrip = {
    status: TIP_WINDOW_STATUS.OPEN,
    trigger: null,
    claimToken: null,
    tipPence: 0,
    captureCalls: 0,
    tipRows: 0,
    tipCredits: 0,
    tenCount: 1,
  };
  const mutex = memoryMutex(trip);
  let tipCredits = 0;
  const capture: CaptureInvokeFn = async () => ({
    ok: true,
    body: {
      success: true,
      status: "captured",
      capture_amount_pence: 700,
      tip_collected_pence: 200,
      provider_state: "COMPLETED",
    },
    captureCallCount: 1,
  });
  const first = await runCustomerTipWindowTrigger({
    tripId: "t1",
    trigger: TIP_WINDOW_TRIGGER.CUSTOMER_SUBMIT_WITH_TIP,
    tipPence: 200,
    claimToken: "dup",
    mutex,
    capture,
    onTipSettled: () => {
      tipCredits += 1;
    },
  });
  assertEquals(first.success, true);
  assertEquals(tipCredits, 1);
  assertEquals(trip.tenCount, 1);

  const second = await runCustomerTipWindowTrigger({
    tripId: "t1",
    trigger: TIP_WINDOW_TRIGGER.CUSTOMER_SUBMIT_WITH_TIP,
    tipPence: 200,
    claimToken: "dup2",
    mutex,
    capture,
    onTipSettled: () => {
      tipCredits += 1;
    },
  });
  assertEquals(second.success, false);
  assertEquals(second.error_code, "ALREADY_CLOSED");
  assertEquals(tipCredits, 1);
  assertEquals(trip.tenCount, 1);
});

Deno.test("12. Completion alone makes zero capture calls", () => {
  const result = runTripCompletionTipWindowOpen({ farePence: 500 });
  assertEquals(result.capture_calls, 0);
  assertEquals(result.tip_window_status, TIP_WINDOW_STATUS.OPEN);
  assertEquals(result.success, true);
});

Deno.test("LOCK: bank decline copy is typed and exact", () => {
  assertEquals(
    TIP_AUTHORISATION_DECLINED_CUSTOMER_MESSAGE,
    "Your bank declined the tip. Your fare has not been taken yet. You can try again, continue without a tip, or skip.",
  );
  assert(!TIP_AUTHORISATION_DECLINED_CUSTOMER_MESSAGE.toLowerCase().includes("fare already taken"));
});

Deno.test("MK-260926-001: fare already captured tip_shortfall refuses — never seals WITH_TIP tip=0", async () => {
  const trip: MemTrip = {
    status: TIP_WINDOW_STATUS.OPEN,
    trigger: null,
    claimToken: null,
    tipPence: 0,
    captureCalls: 0,
    tipRows: 0,
    tipCredits: 0,
    tenCount: 1,
  };
  const result = await runCustomerTipWindowTrigger({
    tripId: "mk-260926-001",
    trigger: TIP_WINDOW_TRIGGER.CUSTOMER_SUBMIT_WITH_TIP,
    tipPence: 200,
    claimToken: "tok-shortfall",
    mutex: memoryMutex(trip),
    capture: async () => ({
      ok: true,
      body: {
        success: true,
        status: "already_captured",
        capture_amount_pence: 500,
        tip_collected_pence: 0,
        tip_shortfall_pence: 200,
        provider_state: "COMPLETED",
      },
      captureCallCount: 1,
    }),
  });
  assertEquals(result.success, false);
  assertEquals(result.error_code, TIP_NOT_COLLECTED);
  assertEquals(result.error, TIP_NOT_COLLECTED_CUSTOMER_MESSAGE);
  assertEquals(result.tip_window_status, TIP_WINDOW_STATUS.CLOSED);
  assertEquals(result.window_released, true);
  assertEquals(trip.status, TIP_WINDOW_STATUS.CLOSED);
  assertEquals(trip.trigger, null);
  assertEquals(trip.tipPence, 0);
  assertEquals(trip.claimToken, null);
});

Deno.test("LOCK: tip>0 decline path removes safeCapture from WITH_TIP", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/_shared/revolutCompletionCapture.ts", import.meta.url),
  );
  assert(src.includes("tip_authorisation_declined_no_fare_capture"));
  assert(src.includes('status: "TIP_AUTHORISATION_DECLINED"'));
  const declineBlockStart = src.indexOf("if (safeTipPence > 0)");
  const safeCaptureIdx = src.indexOf("safeCaptureAfterIncrementDecline", declineBlockStart);
  // Fare-only safe capture remains after the tip>0 early return.
  assert(safeCaptureIdx > declineBlockStart);
  const tipReturn = src.indexOf("TIP_AUTHORISATION_DECLINED", declineBlockStart);
  assert(tipReturn > 0 && tipReturn < safeCaptureIdx);
});

Deno.test("LOCK: submit + expiry wire claim_tip_window_trigger mutex", async () => {
  const submit = await Deno.readTextFile(
    new URL("../../functions/submit-customer-trip-tip/index.ts", import.meta.url),
  );
  const expiry = await Deno.readTextFile(
    new URL("../../functions/capture-expired-tip-windows/index.ts", import.meta.url),
  );
  assert(submit.includes("claimTipWindowTrigger"));
  assert(submit.includes("TIP_AUTHORISATION_DECLINED"));
  assert(submit.includes("TIP_NOT_COLLECTED"));
  assert(submit.includes("tipRequestedButNotCollected"));
  assert(submit.includes("releaseTipWindowTriggerClaim"));
  assert(expiry.includes("claimTipWindowTrigger"));
  assert(expiry.includes("TIP_WINDOW_STATUS.EXPIRED"));
  assert(expiry.includes("WINDOW_EXPIRED"));
});
