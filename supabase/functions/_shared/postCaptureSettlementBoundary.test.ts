import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  isHistoricalWalletTrip,
  mayRetryWalletPosting,
  paymentSessionAllowsWalletPosting,
} from "./postCaptureSettlementBoundary.ts";

const ACTIVATED = Date.parse("2026-08-17T12:00:00.000Z");

Deno.test("historical trip before activation — retry blocked", () => {
  assertEquals(isHistoricalWalletTrip({
    capture_completed_at_iso: "2026-08-17T09:00:00.000Z",
    activated_at_ms: ACTIVATED,
  }), true);
  assertEquals(mayRetryWalletPosting({
    capture_completed_at_iso: "2026-08-17T09:00:00.000Z",
    activated_at_ms: ACTIVATED,
  }), false);
});

Deno.test("unset activation — all recovery/retry is historical detect-only", () => {
  assertEquals(isHistoricalWalletTrip({
    capture_completed_at_iso: "2026-08-17T13:00:00.000Z",
    activated_at_ms: null,
  }), true);
  assertEquals(mayRetryWalletPosting({
    trip_created_at_iso: "2026-08-17T13:00:00.000Z",
    activated_at_ms: null,
  }), false);
});

Deno.test("post-activation capture — canonical recovery posting is allowed", () => {
  assertEquals(mayRetryWalletPosting({
    capture_completed_at_iso: "2026-08-17T13:00:00.000Z",
    activated_at_ms: ACTIVATED,
  }), true);
});

Deno.test("Payment Sessions capture gate: verified captured session only", () => {
  assertEquals(paymentSessionAllowsWalletPosting(null), false);
  assertEquals(paymentSessionAllowsWalletPosting({
    status: "captured",
    provider_state: "COMPLETED",
    captured_amount_pence: 699,
    provider_state_verified_at: null,
  }), false);
  assertEquals(paymentSessionAllowsWalletPosting({
    status: "authorised",
    provider_state: "AUTHORISED",
    captured_amount_pence: 0,
    provider_state_verified_at: "2026-08-17T10:00:00.000Z",
  }), false);
  assertEquals(paymentSessionAllowsWalletPosting({
    status: "captured",
    provider_state: "COMPLETED",
    captured_amount_pence: 699,
    provider_state_verified_at: "2026-08-17T10:00:00.000Z",
  }), true);
});
