/**
 * Slice A lock — Stripe runtime removed from Customer Revolut paths.
 * MK-260813-003 baseline: Revolut behaviour preserved; Stripe secret/SDK gone.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const ROOT = new URL("..", import.meta.url).pathname;

const SLICE_A_FUNCTIONS = [
  "confirm-revolut-payment",
  "create-preauth-payment-intent",
  "setup-revolut-card",
  "get-active-trip",
  "create-trip-after-payment",
  "expire-trip",
  "capture-expired-tip-windows",
] as const;

const FORBIDDEN = [
  "STRIPE_SECRET_KEY",
  'Deno.env.get("STRIPE_SECRET_KEY")',
  "Deno.env.get('STRIPE_SECRET_KEY')",
  "new Stripe",
  "api.stripe.com",
  'from "npm:stripe',
  "from 'npm:stripe",
] as const;

Deno.test("Slice A function sources have zero Stripe secret/SDK runtime refs", () => {
  for (const slug of SLICE_A_FUNCTIONS) {
    const path = `${ROOT}/${slug}/index.ts`;
    const src = Deno.readTextFileSync(path);
    for (const needle of FORBIDDEN) {
      assertEquals(
        src.includes(needle),
        false,
        `${slug} must not contain ${needle}`,
      );
    }
  }
});

Deno.test("Slice A shared helpers no longer read STRIPE_SECRET_KEY", () => {
  const gateway = Deno.readTextFileSync(`${ROOT}/_shared/paymentGatewayStatus.ts`);
  assertEquals(gateway.includes("STRIPE_SECRET_KEY"), false);
  assertEquals(gateway.includes('Deno.env.get("STRIPE_SECRET_KEY")'), false);

  const types = Deno.readTextFileSync(`${ROOT}/_shared/paymentProviders/types.ts`);
  assertEquals(types.includes("STRIPE_SECRET_KEY"), false);

  const index = Deno.readTextFileSync(`${ROOT}/_shared/paymentProviders/index.ts`);
  assertEquals(index.includes("createStripeAdapter"), false);
  assertEquals(index.includes('from "./stripeAdapter.ts"'), false);
});

Deno.test("confirm-revolut-payment preserves Revolut confirmation imports (MK baseline)", () => {
  const src = Deno.readTextFileSync(`${ROOT}/confirm-revolut-payment/index.ts`);
  assertEquals(src.includes("verifyRevolutOrderConfirmedForBooking"), true);
  assertEquals(src.includes("finalizeRevolutTokenCapture"), true);
  assertEquals(src.includes("markPaymentSessionAuthorised"), true);
  assertEquals(src.includes("resolveRevolutMerchantContext"), true);
});

Deno.test("create-preauth-payment-intent still uses Revolut preauth SSOT (not CPI swap)", () => {
  const src = Deno.readTextFileSync(`${ROOT}/create-preauth-payment-intent/index.ts`);
  assertEquals(src.includes("createRevolutPreauthResponse"), true);
  assertEquals(src.includes("create-payment-intent"), false);
});

Deno.test("expire-trip keeps Revolut release and drops Stripe hold branch", () => {
  const src = Deno.readTextFileSync(`${ROOT}/expire-trip/index.ts`);
  assertEquals(src.includes("releaseRevolutPreauthForTrip"), true);
  assertEquals(src.includes("resolveRevolutOrderIdFromTrip"), true);
  assertEquals(src.includes("paymentIntents.cancel"), false);
  assertEquals(src.includes("npm:stripe"), false);
  assertEquals(src.includes("STRIPE_SECRET_KEY"), false);
});

Deno.test("create-trip-after-payment keeps provider evidence / anti-legacy Stripe PI guard", () => {
  const src = Deno.readTextFileSync(`${ROOT}/create-trip-after-payment/index.ts`);
  assertEquals(src.includes("looksLikeStripePaymentIntentId"), true);
  assertEquals(src.includes("gatePaymentSessionForTripCreate"), true);
  assertEquals(src.includes("verifyRevolutHoldForTripCreateFast"), true);
});
