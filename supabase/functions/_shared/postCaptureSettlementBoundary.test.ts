import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  isHistoricalWalletTrip,
  isPaymentSessionLifecycleMismatch,
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
  // Missing provider_state_verified_at → blocked regardless of status.
  assertEquals(paymentSessionAllowsWalletPosting({
    status: "captured",
    provider_state: "COMPLETED",
    captured_amount_pence: 699,
    provider_state_verified_at: null,
  }), false);
  // AUTHORISED provider state → not a completed capture.
  assertEquals(paymentSessionAllowsWalletPosting({
    status: "authorised",
    provider_state: "AUTHORISED",
    captured_amount_pence: 0,
    provider_state_verified_at: "2026-08-17T10:00:00.000Z",
  }), false);
  // Normal captured session → allowed.
  assertEquals(paymentSessionAllowsWalletPosting({
    status: "captured",
    provider_state: "COMPLETED",
    captured_amount_pence: 699,
    provider_state_verified_at: "2026-08-17T10:00:00.000Z",
  }), true);
  // MK-260817-007/008/009 pattern: status="trip_created" but provider evidence is authoritative.
  // The gate now requires status="captured" — lifecycle mismatch must be finalized first.
  assertEquals(paymentSessionAllowsWalletPosting({
    status: "trip_created",
    provider_state: "COMPLETED",
    captured_amount_pence: 480,
    provider_state_verified_at: "2026-08-17T18:50:46.979Z",
  }), false, "trip_created must not pass wallet gate — finalize first");
  // PAYMENT_RECOVERY purpose → never posts wallet even if provider state is COMPLETED.
  assertEquals(paymentSessionAllowsWalletPosting({
    status: "captured",
    provider_state: "COMPLETED",
    captured_amount_pence: 199,
    provider_state_verified_at: "2026-08-17T18:50:46.979Z",
    purpose: "PAYMENT_RECOVERY",
  }), false);
  // Zero captured_amount → blocked.
  assertEquals(paymentSessionAllowsWalletPosting({
    status: "trip_created",
    provider_state: "COMPLETED",
    captured_amount_pence: 0,
    provider_state_verified_at: "2026-08-17T18:50:46.979Z",
  }), false);
  // Refunded session → blocked.
  assertEquals(paymentSessionAllowsWalletPosting({
    status: "captured",
    provider_state: "COMPLETED",
    captured_amount_pence: 480,
    provider_state_verified_at: "2026-08-17T10:00:00.000Z",
    refunded_amount_pence: 480,
  }), false);
  // Released session → blocked.
  assertEquals(paymentSessionAllowsWalletPosting({
    status: "captured",
    provider_state: "COMPLETED",
    captured_amount_pence: 480,
    provider_state_verified_at: "2026-08-17T10:00:00.000Z",
    released_amount_pence: 480,
    hold_release_state: "RELEASED",
  }), false);
});

Deno.test("Payment Sessions lifecycle mismatch detection", () => {
  // Already consistent → not a mismatch.
  assertEquals(isPaymentSessionLifecycleMismatch({
    status: "captured",
    provider_state: "COMPLETED",
    captured_amount_pence: 480,
    provider_state_verified_at: "2026-08-17T18:50:46.979Z",
  }), false);
  // MK-007/008/009 pattern: trip_created + COMPLETED + captured > 0 + verified_at → mismatch.
  assertEquals(isPaymentSessionLifecycleMismatch({
    status: "trip_created",
    provider_state: "COMPLETED",
    captured_amount_pence: 480,
    provider_state_verified_at: "2026-08-17T18:50:46.979Z",
  }), true);
  // No provider verification → not a mismatch we can safely finalize.
  assertEquals(isPaymentSessionLifecycleMismatch({
    status: "trip_created",
    provider_state: "COMPLETED",
    captured_amount_pence: 480,
    provider_state_verified_at: null,
  }), false);
  // Not-COMPLETED provider state → not a mismatch.
  assertEquals(isPaymentSessionLifecycleMismatch({
    status: "trip_created",
    provider_state: "AUTHORISED",
    captured_amount_pence: 480,
    provider_state_verified_at: "2026-08-17T18:50:46.979Z",
  }), false);
  // Null session → false.
  assertEquals(isPaymentSessionLifecycleMismatch(null), false);
});
