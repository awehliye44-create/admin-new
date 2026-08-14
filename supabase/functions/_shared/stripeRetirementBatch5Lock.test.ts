/**
 * Batch 5 lock — provider env-map string cleanup redeploys.
 *
 * Redeployed with empty PROVIDER_ENV_SECRET_MAP.stripe (Slice A local map):
 *   abandon-payment-session, admin-hold-action, admin-payment-holds-reconciliation,
 *   admin-payment-sessions, admin-recover-revolut-orphan, admin-register-revolut-webhook,
 *   admin-remediate-trip-payment, admin-revolut-orphan-reconciliation,
 *   charge-lifecycle-fee, report-payment-recovery-needed
 *
 * SKIPPED:
 *   commission-wallet-topup-webhook — Commission Wallet WIP taboo; do not redeploy local WIP
 *
 * Do not reintroduce STRIPE_SECRET_KEY into PROVIDER_ENV_SECRET_MAP.stripe.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const SHARED = new URL(".", import.meta.url).pathname;

Deno.test("Batch 5: PROVIDER_ENV_SECRET_MAP.stripe has no STRIPE_SECRET_KEY binding", () => {
  const types = Deno.readTextFileSync(`${SHARED}/paymentProviders/types.ts`);
  assertEquals(types.includes('secret_key: "STRIPE_SECRET_KEY"'), false);
  assertEquals(types.includes("Stripe retired"), true);
});
