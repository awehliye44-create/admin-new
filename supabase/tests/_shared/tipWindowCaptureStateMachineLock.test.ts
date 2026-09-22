/**
 * Canonical tip-window capture sequence — state-machine lock tests.
 *
 * Run:
 *   deno test --allow-read supabase/tests/_shared/tipWindowCaptureStateMachineLock.test.ts
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  FORBIDDEN_CAPTURE_SOURCES,
  TIP_WINDOW_MS,
  applyCaptureTrigger,
  applyTriggerIdempotent,
  initialTipWindowMachineState,
  isWindowOpen,
  mayStampLocalCaptured,
  onTripCompleted,
  pickRaceWinner,
  resolveCaptureTrigger,
} from "../../functions/_shared/tipWindowCaptureStateMachineSSOT.ts";
import { durableSettlementColumns } from "../../functions/_shared/durableSettlementOutcomeSSOT.ts";
import { tipWindowCloseAllowedAfterFinalize } from "../../functions/_shared/tripPaymentFinalised.ts";

const T0 = Date.parse("2026-09-22T13:35:29.543Z");
const FARE = 500;

function completedOpen() {
  return onTripCompleted(initialTipWindowMachineState(), T0, FARE);
}

Deno.test("LOCK: completion is not a capture trigger", () => {
  const s = completedOpen();
  assertEquals(s.tipWindow, "open");
  assertEquals(s.tipWindowOpenedAtMs, T0);
  assertEquals(s.tipWindowExpiresAtMs, T0 + TIP_WINDOW_MS);
  assertEquals(s.provider, "authorised");
  assertEquals(s.localPayment, "authorised");
  assertEquals(s.captureCount, 0);
  assertEquals(s.tenPosted, true);
  assertEquals(s.tenCount, 1);
  assertEquals(s.tipCreditCount, 0);
  assertEquals(FORBIDDEN_CAPTURE_SOURCES.includes("trip_completion"), true);
});

Deno.test("A CUSTOMER_SKIP → fare-only capture once after provider COMPLETED", () => {
  let s = completedOpen();
  s = applyCaptureTrigger(s, {
    atMs: T0 + 60_000,
    trigger: "CUSTOMER_SKIP",
    providerCompleted: true,
  });
  assertEquals(s.localPayment, "captured");
  assertEquals(s.provider, "captured");
  assertEquals(s.tipPence, 0);
  assertEquals(s.tipCreditCount, 0);
  assertEquals(s.captureCount, 1);
  assertEquals(s.tenCount, 1);
  assertEquals(s.lastTrigger, "CUSTOMER_SKIP");
  assertEquals(s.tipWindow, "closed");
});

Deno.test("B CUSTOMER_SUBMIT_NO_TIP → fare-only capture once", () => {
  let s = completedOpen();
  s = applyCaptureTrigger(s, {
    atMs: T0 + 30_000,
    trigger: "CUSTOMER_SUBMIT_NO_TIP",
    tipPence: 0,
    providerCompleted: true,
  });
  assertEquals(s.tipPence, 0);
  assertEquals(s.captureCount, 1);
  assertEquals(s.tipCreditCount, 0);
  assertEquals(s.lastTrigger, "CUSTOMER_SUBMIT_NO_TIP");
});

Deno.test("C CUSTOMER_SUBMIT_WITH_TIP happy path → fare+tip once", () => {
  let s = completedOpen();
  s = applyCaptureTrigger(s, {
    atMs: T0 + TIP_WINDOW_MS - 1000,
    trigger: "CUSTOMER_SUBMIT_WITH_TIP",
    tipPence: 200,
    tipAuthOk: true,
    providerCompleted: true,
  });
  assertEquals(s.tipPence, 200);
  assertEquals(s.tipCreditPosted, true);
  assertEquals(s.tipCreditCount, 1);
  assertEquals(s.captureCount, 1);
  assertEquals(s.tenCount, 1);
  assertEquals(s.lastTrigger, "CUSTOMER_SUBMIT_WITH_TIP");
  assertEquals(s.tipWindow, "closed");
});

Deno.test("C tip auth declined → no fare capture, no tip, window stays open", () => {
  let s = completedOpen();
  s = applyCaptureTrigger(s, {
    atMs: T0 + 10_000,
    trigger: "CUSTOMER_SUBMIT_WITH_TIP",
    tipPence: 200,
    tipAuthOk: false,
    providerCompleted: false,
  });
  assertEquals(s.localPayment, "authorised");
  assertEquals(s.provider, "declined_tip_auth");
  assertEquals(s.tipPence, 0);
  assertEquals(s.tipCreditCount, 0);
  assertEquals(s.captureCount, 0);
  assertEquals(s.tipWindow, "open");
  assertEquals(s.customerMessage, "bank_declined_tip");
  assertEquals(isWindowOpen(s, T0 + 10_000), true);
});

Deno.test("C provider capture not confirmed → do not stamp local captured / do not close", () => {
  let s = completedOpen();
  s = applyCaptureTrigger(s, {
    atMs: T0 + 10_000,
    trigger: "CUSTOMER_SUBMIT_WITH_TIP",
    tipPence: 100,
    tipAuthOk: true,
    providerCompleted: false,
  });
  assertEquals(s.localPayment, "authorised");
  assertEquals(s.captureCount, 0);
  assertEquals(s.tipWindow, "open");
  assertEquals(s.customerMessage, "provider_capture_not_confirmed");
});

Deno.test("D WINDOW_EXPIRED → fare-only once, close as expired", () => {
  let s = completedOpen();
  const after = T0 + TIP_WINDOW_MS + 1;
  assertEquals(isWindowOpen(s, after), false);
  s = applyCaptureTrigger(s, {
    atMs: after,
    trigger: "WINDOW_EXPIRED",
    providerCompleted: true,
  });
  assertEquals(s.tipPence, 0);
  assertEquals(s.captureCount, 1);
  assertEquals(s.tipWindow, "expired_closed");
  assertEquals(s.lastTrigger, "WINDOW_EXPIRED");
});

Deno.test("D cannot expire while window still open", () => {
  const s0 = completedOpen();
  const denied = resolveCaptureTrigger({
    state: s0,
    atMs: T0 + 60_000,
    requested: "WINDOW_EXPIRED",
  });
  assertEquals(denied.ok, false);
});

Deno.test("HARD: capture_amount alone is not proof of capture", () => {
  assertEquals(
    mayStampLocalCaptured({ providerCompleted: false, captureAmountPence: 500 }),
    false,
  );
  assertEquals(
    mayStampLocalCaptured({ providerCompleted: true, captureAmountPence: 500 }),
    true,
  );
  assertEquals(
    tipWindowCloseAllowedAfterFinalize({
      success: true,
      status: "authorized",
      capture_amount_pence: 500,
      provider_state: "AUTHORISED",
    }),
    false,
  );
  assertEquals(durableSettlementColumns("authorized", true).payment_status, "authorized");
});

Deno.test("HARD: AUTHORISED must remain locally authorised until provider COMPLETED", () => {
  let s = completedOpen();
  s = applyCaptureTrigger(s, {
    atMs: T0 + 5_000,
    trigger: "CUSTOMER_SKIP",
    providerCompleted: false,
  });
  assertEquals(s.localPayment, "authorised");
  assertEquals(s.provider, "authorised");
});

Deno.test("RACE: Skip vs expiry at same instant → one fare-only winner", () => {
  const s0 = completedOpen();
  const at = T0 + TIP_WINDOW_MS; // exactly at boundary: open is atMs < expires
  // At expires_at exactly, window is closed for customer; expiry valid.
  const atExpiry = T0 + TIP_WINDOW_MS;
  const winner = pickRaceWinner({
    state: s0,
    atMs: atExpiry,
    candidates: ["CUSTOMER_SKIP", "WINDOW_EXPIRED"],
  });
  // Skip requires open window (atMs < expires). At exact expires, only expiry wins.
  assertEquals(winner, "WINDOW_EXPIRED");
  void at;

  // One second before expiry, Skip wins over a premature expiry candidate.
  const before = T0 + TIP_WINDOW_MS - 1;
  const winnerOpen = pickRaceWinner({
    state: s0,
    atMs: before,
    candidates: ["CUSTOMER_SKIP", "WINDOW_EXPIRED"],
  });
  assertEquals(winnerOpen, "CUSTOMER_SKIP");

  let s = applyCaptureTrigger(s0, {
    atMs: before,
    trigger: winnerOpen!,
    providerCompleted: true,
  });
  s = applyTriggerIdempotent(s, {
    atMs: atExpiry,
    trigger: "WINDOW_EXPIRED",
    providerCompleted: true,
  });
  assertEquals(s.captureCount, 1);
  assertEquals(s.tipCreditCount, 0);
  assertEquals(s.tenCount, 1);
});

Deno.test("RACE: Submit-with-tip vs expiry → one winner", () => {
  const s0 = completedOpen();
  const before = T0 + TIP_WINDOW_MS - 500;
  const winner = pickRaceWinner({
    state: s0,
    atMs: before,
    candidates: ["CUSTOMER_SUBMIT_WITH_TIP", "WINDOW_EXPIRED"],
  });
  assertEquals(winner, "CUSTOMER_SUBMIT_WITH_TIP");

  let s = applyCaptureTrigger(s0, {
    atMs: before,
    trigger: "CUSTOMER_SUBMIT_WITH_TIP",
    tipPence: 100,
    tipAuthOk: true,
    providerCompleted: true,
  });
  s = applyTriggerIdempotent(s, {
    atMs: T0 + TIP_WINDOW_MS + 1,
    trigger: "WINDOW_EXPIRED",
    providerCompleted: true,
  });
  assertEquals(s.captureCount, 1);
  assertEquals(s.tipCreditCount, 1);
  assertEquals(s.tipPence, 100);

  // After expiry, tip submit loses; expiry wins once.
  const sLate = completedOpen();
  const lateWinner = pickRaceWinner({
    state: sLate,
    atMs: T0 + TIP_WINDOW_MS + 1,
    candidates: ["CUSTOMER_SUBMIT_WITH_TIP", "WINDOW_EXPIRED"],
  });
  assertEquals(lateWinner, "WINDOW_EXPIRED");
});

Deno.test("RACE: duplicate Skip is idempotent — no second capture/TEN/tip", () => {
  let s = completedOpen();
  s = applyCaptureTrigger(s, {
    atMs: T0 + 1_000,
    trigger: "CUSTOMER_SKIP",
    providerCompleted: true,
  });
  s = applyTriggerIdempotent(s, {
    atMs: T0 + 2_000,
    trigger: "CUSTOMER_SKIP",
    providerCompleted: true,
  });
  assertEquals(s.captureCount, 1);
  assertEquals(s.tenCount, 1);
  assertEquals(s.tipCreditCount, 0);
  assertEquals(s.customerMessage, "already_captured");
});

Deno.test("RACE: Submit-no-tip vs Skip → one fare-only capture", () => {
  const s0 = completedOpen();
  const at = T0 + 5_000;
  const winner = pickRaceWinner({
    state: s0,
    atMs: at,
    candidates: ["CUSTOMER_SKIP", "CUSTOMER_SUBMIT_NO_TIP"],
  });
  assertEquals(winner, "CUSTOMER_SUBMIT_NO_TIP");
  let s = applyCaptureTrigger(s0, {
    atMs: at,
    trigger: winner!,
    providerCompleted: true,
  });
  s = applyTriggerIdempotent(s, {
    atMs: at + 1,
    trigger: "CUSTOMER_SKIP",
    providerCompleted: true,
  });
  assertEquals(s.captureCount, 1);
  assertEquals(s.tipPence, 0);
});

Deno.test("LOCK: source wires still forbid completion capture on tip-deferred path", async () => {
  const stop = await Deno.readTextFile(
    new URL("../../functions/stop-workflow/index.ts", import.meta.url),
  );
  assertEquals(stop.includes("tip_window_capture_deferred"), true);
  assertEquals(stop.includes("deferCaptureForTipWindow"), true);

  const tipSubmit = await Deno.readTextFile(
    new URL("../../functions/submit-customer-trip-tip/index.ts", import.meta.url),
  );
  assertEquals(tipSubmit.includes("submit_customer_trip_tip"), true);
  assertEquals(tipSubmit.includes("tipWindowCloseAllowedAfterFinalize"), true);

  const expiry = await Deno.readTextFile(
    new URL("../../functions/capture-expired-tip-windows/index.ts", import.meta.url),
  );
  assertEquals(expiry.includes("expiryFareOnlyTipPence"), true);
  assertEquals(expiry.includes("capture_expired_tip_windows"), true);
});
