/**
 * Lock: Revolut hold release — dispose SELECT + cancel-trip + classify safety.
 * Run: deno test --allow-read supabase/functions/_shared/revolutHoldReleaseDefectLock.test.ts
 */
import {
  assertEquals,
  assertStringIncludes,
  assert,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { classifyTerminalHoldDisposition } from "./terminalTripPaymentDisposition.ts";

const disposePath = new URL("./terminalTripPaymentDisposition.ts", import.meta.url);
const cancelPath = new URL("../cancel-trip/index.ts", import.meta.url);
const sweepPath = new URL("../sweep-revolut-stale-holds/index.ts", import.meta.url);
const expirePath = new URL("../expire-trip/index.ts", import.meta.url);

Deno.test("H: disposeTerminalTripPayment must not SELECT stripe_payment_intent_id", async () => {
  const src = await Deno.readTextFile(disposePath);
  // Extract the dispose trip SELECT string literal that lists columns.
  const m = src.match(
    /disposeTerminalTripPayment[\s\S]*?\.from\("trips"\)\s*\.select\(\s*(?:\/\/[^\n]*\n\s*)*"([^"]+stripe[^"]*|[^"]+)"/,
  );
  // Prefer direct assertion on known select content
  assertStringIncludes(
    src,
    '"id, status, started_at, arrived_at, free_wait_expires_at, cancelled_at, cancelled_by, cancellation_reason, scheduled_at, cancellation_grace_expires_at, driver_id, confirmed_driver_id, service_area_id, vehicle_type_id, payment_provider, provider_order_id, payment_session_id, authorised_amount_pence, cancellation_fee_pence, no_show_charge_pence, payment_status, arrival_cancellation_applied, dispatch_mode, scheduled_status, is_scheduled"',
  );
  assertEquals(src.includes("provider_order_id, stripe_payment_intent_id"), false);
  assertEquals(src.includes("stripe_payment_intent_id, authorised_amount_pence"), false);
  void m;
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
