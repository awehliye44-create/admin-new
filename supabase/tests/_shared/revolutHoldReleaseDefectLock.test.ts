/**
 * Lock: Revolut hold release — dispose SELECT + cancel-trip + classify safety.
 * Run: deno test --allow-read supabase/functions/_shared/revolutHoldReleaseDefectLock.test.ts
 */
import {
  assertEquals,
  assertStringIncludes,
  assert,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { classifyTerminalHoldDisposition } from "../../functions/_shared/terminalTripPaymentDisposition.ts";

const disposePath = new URL("../../functions/_shared/terminalTripPaymentDisposition.ts", import.meta.url);
const cancelPath = new URL("../../functions/cancel-trip/index.ts", import.meta.url);
const sweepPath = new URL("../../functions/sweep-revolut-stale-holds/index.ts", import.meta.url);
const expirePath = new URL("../../functions/expire-trip/index.ts", import.meta.url);

Deno.test("H: disposeTerminalTripPayment must not SELECT stripe_payment_intent_id", async () => {
  const src = await Deno.readTextFile(disposePath);
  // Baseline (pre-Phase-1, MK-261104-003): previous_driver_id was added to the
  // dispose SELECT for late-cancel entitlement. The lock is Stripe absence +
  // required Revolut/session columns — not a frozen exact column string.
  assertStringIncludes(src, "previous_driver_id");
  assertStringIncludes(src, "provider_order_id");
  assertStringIncludes(src, "payment_session_id");
  assertStringIncludes(src, "authorised_amount_pence");
  assertStringIncludes(src, "never select removed provider PI columns");
  assertEquals(src.includes("provider_order_id, stripe_payment_intent_id"), false);
  assertEquals(src.includes("stripe_payment_intent_id, authorised_amount_pence"), false);
  assertEquals(/\bstripe_payment_intent_id\b/.test(src), false);
});

Deno.test("K: no Stripe runtime reintroduced in dispose/cancel", async () => {
  const dispose = await Deno.readTextFile(disposePath);
  const cancel = await Deno.readTextFile(cancelPath);
  assertEquals(/stripe\.com|Stripe\(|new Stripe/.test(dispose), false);
  assertEquals(/stripe\.com|Stripe\(|new Stripe/.test(cancel), false);
  assertEquals(dispose.includes("provider_order_id, stripe_payment_intent_id"), false);
  assertEquals(dispose.includes("stripe_payment_intent_id, authorised_amount_pence"), false);
});

Deno.test("A/G: cancelled + AUTHORISED classifies void_full when fee=0; partial when fee>0", () => {
  assertEquals(
    classifyTerminalHoldDisposition({
      tripStatus: "cancelled",
      startedAt: null,
      feePence: 0,
      hasProviderOrder: true,
      provider: "revolut",
    }).action,
    "void_full",
  );
  assertEquals(
    classifyTerminalHoldDisposition({
      tripStatus: "cancelled",
      startedAt: null,
      feePence: 150,
      hasProviderOrder: true,
      provider: "revolut",
    }).action,
    "partial_capture_fee",
  );
});

Deno.test("B: expired + AUTHORISED → void_full", () => {
  assertEquals(
    classifyTerminalHoldDisposition({
      tripStatus: "expired",
      startedAt: null,
      feePence: 0,
      hasProviderOrder: true,
      provider: "revolut",
    }).action,
    "void_full",
  );
});

Deno.test("E/F: completed and active trips skip release", () => {
  assertEquals(
    classifyTerminalHoldDisposition({
      tripStatus: "completed",
      hasProviderOrder: true,
      provider: "revolut",
    }).action,
    "skip",
  );
  assertEquals(
    classifyTerminalHoldDisposition({
      tripStatus: "accepted",
      hasProviderOrder: true,
      provider: "revolut",
      feePence: 0,
    }).action,
    "skip",
  );
  assertEquals(
    classifyTerminalHoldDisposition({
      tripStatus: "searching",
      hasProviderOrder: true,
      provider: "revolut",
    }).action,
    "skip",
  );
});

Deno.test("cancel-trip invokes disposeTerminalTripPayment after terminal commit", async () => {
  const src = await Deno.readTextFile(cancelPath);
  assertStringIncludes(src, 'from "../_shared/terminalTripPaymentDisposition.ts"');
  assertStringIncludes(src, "disposeTerminalTripPayment");
  assertStringIncludes(src, "forceFeePenceOverride: true");
  assertStringIncludes(src, "feePence: appliedFee");
  assertStringIncludes(src, "customer_cancel");
  assertStringIncludes(src, "admin_cancel");
  // Must not invent a new Revolut cancel client
  assertEquals(src.includes("cancelRevolutOrder"), false);
});

Deno.test("I/J: sweep uses disposeTerminalTripPayment; expire keeps release helper", async () => {
  const sweep = await Deno.readTextFile(sweepPath);
  assertStringIncludes(sweep, "disposeTerminalTripPayment");
  assertStringIncludes(sweep, "TERMINAL");
  const expire = await Deno.readTextFile(expirePath);
  assertStringIncludes(expire, "releaseRevolutPreauthForTrip");
});

Deno.test("C: post-cancel prefers cancel response when retrieve lags", async () => {
  const src = await Deno.readTextFile(disposePath);
  assertStringIncludes(src, "const cancelResult = await cancelRevolutOrder");
  assertStringIncludes(src, "RELEASED_PROVIDER.has(cancelState)");
  assertStringIncludes(src, "post_cancel_not_released");
});
