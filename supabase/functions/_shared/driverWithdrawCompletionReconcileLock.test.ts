/**
 * Lock: provider COMPLETED reconcile finalizes once; never /pay; fee formula SSOT.
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const RECONCILE = new URL("./driverWithdrawProviderReconcile.ts", import.meta.url);
const RELAY = new URL("./revolutBusinessRelayClient.ts", import.meta.url);
const EDGE = new URL("../driver-withdraw/index.ts", import.meta.url);
const MIGRATION = new URL(
  "../../migrations/20260814140000_driver_withdraw_completion_reconcile_rls.sql",
  import.meta.url,
);

Deno.test("reconcile helper never calls /pay", async () => {
  const src = await Deno.readTextFile(RECONCILE);
  assertEquals(src.includes("relayApprovedDriverPayoutPayment("), false);
  // Status helper name contains the pay helper prefix — exclude Status.
  assertEquals(/\brelayApprovedDriverPayoutPayment\b(?!Status)/.test(src), false);
  assertStringIncludes(src, "relayApprovedDriverPayoutPaymentStatus");
  assertStringIncludes(src, "finalize_driver_payout_completion");
  assertStringIncludes(src, 'liveState !== "completed"');
});

Deno.test("relay status client is read-only GET transaction path", async () => {
  const src = await Deno.readTextFile(RELAY);
  assertStringIncludes(src, "driver-payout-payment-status");
  assertStringIncludes(src, "revolut_pay_called: false");
  assertStringIncludes(src, "export async function relayApprovedDriverPayoutPaymentStatus");
});

Deno.test("migration grants driver SELECT on EARLY_CASHOUT payout SSOT", async () => {
  const src = await Deno.readTextFile(MIGRATION);
  assertStringIncludes(src, "Drivers read own early cashout payout items");
  assertStringIncludes(src, "Drivers read own early cashout payout batches");
  assertStringIncludes(src, "kind = 'EARLY_CASHOUT'");
  assertStringIncludes(src, "CASHOUT_FEE");
  assertStringIncludes(src, "PROVIDER_NOT_COMPLETED");
});

Deno.test("fee formula: wallet gross - fee = provider transfer", async () => {
  const src = await Deno.readTextFile(EDGE);
  assertStringIncludes(
    src,
    'fee_formula: "provider_transfer = wallet_gross - withdrawal_fee"',
  );
  // Gross reserved on item; net sent to provider
  assertStringIncludes(src, "amount_pence: amountPence");
  assertStringIncludes(src, "net_driver_payout_pence: providerTransferPence");
});
