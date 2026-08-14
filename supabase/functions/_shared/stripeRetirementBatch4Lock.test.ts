/**
 * Batch 4 lock — driver-payout-settings Stripe Connect strip.
 *
 * Keep the Edge. Remove Connect UI/runtime + STRIPE_SECRET_KEY env reads from
 * the bundled gateway path. Preserve UK-bank / Revolut destination contract.
 *
 * confirm-trip-payment: undeployed (no callers; Stripe PI fetch optional only).
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const SHARED = new URL(".", import.meta.url).pathname;

Deno.test("driver-payout-settings source has no Stripe secret / Connect status helper", () => {
  const index = Deno.readTextFileSync(`${ROOT}/driver-payout-settings/index.ts`);
  const payload = Deno.readTextFileSync(`${SHARED}/buildDriverPayoutSettingsPayload.ts`);
  const dest = Deno.readTextFileSync(`${SHARED}/driverPayoutDestinationSSOT.ts`);

  assertEquals(index.includes("STRIPE_SECRET_KEY"), false);
  assertEquals(index.includes("stripe_account_id"), false);
  assertEquals(payload.includes("stripeConnectProviderStatus"), false);
  assertEquals(payload.includes("STRIPE_SECRET_KEY"), false);
  assertEquals(payload.includes('payout_destination_ui: usesStripe ? "stripe_connect"'), false);
  assertEquals(dest.includes("stripeConnectProviderStatus"), false);
  // Stripe provider areas fail closed to blocked UI (no Connect).
  assertEquals(payload.includes('provider === "stripe"'), true);
  assertEquals(payload.includes('payout_destination_ui: "blocked"'), true);
});

Deno.test("confirm-trip-payment stays undeployed (no local rewrite)", () => {
  let exists = false;
  try {
    Deno.statSync(`${ROOT}/confirm-trip-payment/index.ts`);
    exists = true;
  } catch {
    exists = false;
  }
  assertEquals(exists, false);
});
