import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  CAPTURED_AT_RESTAMP_SUSPECT,
  isCapturedAtRestampSuspect,
  resolvePaymentSessionCaptureAdvanceExtras,
  resolveStablePayoutClearingOriginMs,
} from "./paymentSessionCaptureTimestampSSOT.ts";

Deno.test("preserve captured_at when refresh sees existing capture", () => {
  const extras = resolvePaymentSessionCaptureAdvanceExtras({
    storedCapturedAt: "2026-08-15T10:00:00.000Z",
    storedCapturedAmountPence: 680,
    incomingCapturedAmountPence: 680,
    nowIso: "2026-09-01T20:22:26.000Z",
  });
  assertEquals(extras.captured_at, undefined);
  assertEquals(extras.captured_amount_pence, undefined);
});

Deno.test("first capture stamps captured_at once", () => {
  const extras = resolvePaymentSessionCaptureAdvanceExtras({
    storedCapturedAt: null,
    storedCapturedAmountPence: null,
    incomingCapturedAmountPence: 680,
    nowIso: "2026-08-15T10:00:00.000Z",
  });
  assertEquals(extras.captured_amount_pence, 680);
  assertEquals(extras.captured_at, "2026-08-15T10:00:00.000Z");
});

Deno.test("amount reconcile without captured_at restamp", () => {
  const extras = resolvePaymentSessionCaptureAdvanceExtras({
    storedCapturedAt: "2026-08-15T10:00:00.000Z",
    storedCapturedAmountPence: 650,
    incomingCapturedAmountPence: 680,
    nowIso: "2026-09-01T20:22:26.000Z",
  });
  assertEquals(extras.captured_amount_pence, 680);
  assertEquals(extras.captured_at, undefined);
});

Deno.test("restamp suspect uses trip completion not forward captured_at", () => {
  assertEquals(
    isCapturedAtRestampSuspect({
      captured_at: "2026-09-01T20:22:26.000Z",
      trip_completed_at: "2026-08-15T08:00:00.000Z",
      ledger_created_at: "2026-08-15T08:05:00.000Z",
    }),
    true,
  );

  const origin = resolveStablePayoutClearingOriginMs({
    captured_at: "2026-09-01T20:22:26.000Z",
    trip_completed_at: "2026-08-15T08:00:00.000Z",
    earning_credited_at: "2026-08-15T08:05:00.000Z",
  });
  assertEquals(origin, Date.parse("2026-08-15T08:00:00.000Z"));
});

Deno.test("CAPTURED_AT_RESTAMP_SUSPECT code is stable", () => {
  assertEquals(CAPTURED_AT_RESTAMP_SUSPECT, "CAPTURED_AT_RESTAMP_SUSPECT");
});
