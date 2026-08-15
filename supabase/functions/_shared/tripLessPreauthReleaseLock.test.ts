/**
 * Lock: authorised Revolut hold with no trip must be releasable.
 * Run: deno test --allow-read supabase/functions/_shared/tripLessPreauthReleaseLock.test.ts
 */
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  sessionAgeMs,
  shouldForceAuthorisedSessionRelease,
  TRIPLESS_AUTHORISED_HOLD_SWEEP_MIN_AGE_MS,
} from "./holdReleasePure.ts";

const holdPath = new URL("./holdReleaseSSOT.ts", import.meta.url);
const sessionPath = new URL("./paymentSessionSSOT.ts", import.meta.url);
const abandonPath = new URL("../abandon-payment-session/index.ts", import.meta.url);
const sweepPath = new URL("../sweep-revolut-stale-holds/index.ts", import.meta.url);
const ctapPath = new URL("../create-trip-after-payment/index.ts", import.meta.url);

Deno.test("session-only release exports exist and never require a trip", async () => {
  const src = await Deno.readTextFile(holdPath);
  assertStringIncludes(src, "export async function releaseHoldForPaymentSession");
  assertStringIncludes(src, "sessionAgeMs");
  assertStringIncludes(src, "export async function attemptHoldRecoveryOnce");
  assertStringIncludes(src, "cancelRevolutOrder");
  assertStringIncludes(src, "markPaymentSessionReleased");
  assertEquals(src.includes('reason: "missing_trip_id"'), false);
  assertEquals(src.includes("captureRevolutOrder"), false);
  assertStringIncludes(src, "persistTriplessSessionReleased");
  assertStringIncludes(src, "provider_state first");
  assertStringIncludes(src, 'provider_state: args.providerState');
  const pure = await Deno.readTextFile(new URL("./holdReleasePure.ts", import.meta.url));
  assertStringIncludes(pure, "export function sessionAgeMs");
});

Deno.test("force-release reasons skip the 30s abandon grace", () => {
  assertEquals(shouldForceAuthorisedSessionRelease("create_trip_failed_to_start"), true);
  assertEquals(shouldForceAuthorisedSessionRelease("booking_failed_no_trip"), true);
  assertEquals(shouldForceAuthorisedSessionRelease("edge_boot_failure"), true);
  assertEquals(shouldForceAuthorisedSessionRelease("customer_cancelled_authorised_hold"), true);
  assertEquals(shouldForceAuthorisedSessionRelease("checkout_abandoned"), false);
});

Deno.test("sessionAgeMs uses authorised_at then created_at", () => {
  const now = Date.now();
  const age = sessionAgeMs({
    authorised_at: new Date(now - 45_000).toISOString(),
    created_at: new Date(now - 120_000).toISOString(),
  });
  assert(age >= 40_000 && age < 60_000);
});

Deno.test("abandon force-releases CTAP boot failures immediately", async () => {
  const src = await Deno.readTextFile(abandonPath);
  assertStringIncludes(src, "shouldForceAuthorisedSessionRelease");
  assertStringIncludes(src, "releaseHoldForPaymentSession");
  assertStringIncludes(src, "authorised_too_recent");
  assert(src.includes("forceRelease"));
  assertStringIncludes(src, "abandon_pending_");
  assertStringIncludes(src, "success: false");
  assertStringIncludes(src, "release_failed");
  assert(
    src.includes("abandon_pending_") &&
      src.includes('return json({\n      success: false,'),
    "pending Revolut cancel failure must not return 200 abandoned_only",
  );
});

Deno.test("sweep releases trip-less AUTHORISED holds after grace", async () => {
  const src = await Deno.readTextFile(sweepPath);
  assertStringIncludes(src, "releaseHoldForPaymentSession");
  assertStringIncludes(src, "TRIPLESS_AUTHORISED_HOLD_SWEEP_MIN_AGE_MS");
  assertStringIncludes(src, '.is("trip_id", null)');
  assertStringIncludes(src, "sweep_tripless_authorised_hold");
  assertStringIncludes(src, "closed_local_only_stale");
  assertStringIncludes(src, '.is("provider_order_id", null)');
  assertEquals(TRIPLESS_AUTHORISED_HOLD_SWEEP_MIN_AGE_MS >= 3 * 60 * 1000, true);
  // Trip-scoped dispose path must stay (completed/cancelled trips).
  assertStringIncludes(src, "disposeTerminalTripPayment");
});

Deno.test("markPaymentSessionReleased flips provider_state before status cancelled", async () => {
  const src = await Deno.readTextFile(sessionPath);
  assertStringIncludes(src, "provider_state pre-flip");
  assertStringIncludes(src, "prevent_authorised_session_client_cancel");
  assertStringIncludes(src, 'provider_state_verified_by: "markPaymentSessionReleased"');
});

Deno.test("CTAP still reverses in-function when it actually starts", async () => {
  const src = await Deno.readTextFile(ctapPath);
  assertStringIncludes(src, "failBookingAfterAuthorizedRevolutOrder");
  assertStringIncludes(src, "releaseHoldForPaymentSession");
  assertStringIncludes(src, "BOOKING_FAILED_PREAUTH_REVERSED");
});
