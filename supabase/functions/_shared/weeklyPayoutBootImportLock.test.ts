import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const WEEKLY = new URL("../admin-execute-weekly-payout-occurrence/index.ts", import.meta.url);
const RELAY = new URL("./revolutBusinessRelayClient.ts", import.meta.url);

Deno.test("relay exports only relayApprovedDriverPayoutPaymentStatus (no legacy alias)", async () => {
  const src = await Deno.readTextFile(RELAY);
  assertStringIncludes(src, "export async function relayApprovedDriverPayoutPaymentStatus");
  assertEquals(src.includes("export async function relayDriverPayoutPaymentStatus"), false);
  assertEquals(
    src.includes("export { relayApprovedDriverPayoutPaymentStatus as relayDriverPayoutPaymentStatus }"),
    false,
  );
});

Deno.test("weekly executor boots against canonical relay status export", async () => {
  const src = await Deno.readTextFile(WEEKLY);
  assertStringIncludes(src, "relayApprovedDriverPayoutPaymentStatus");
  assertEquals(src.includes("relayDriverPayoutPaymentStatus"), false);
  assertStringIncludes(src, "relayApprovedDriverPayoutPayment");
});

Deno.test("weekly uses status retrieve path and single pay helper", async () => {
  const src = await Deno.readTextFile(WEEKLY);
  assertStringIncludes(src, "relayApprovedDriverPayoutPaymentStatus({");
  assertStringIncludes(src, "relayApprovedDriverPayoutPayment({");
  assertEquals(src.includes("relayDriverPayoutPayment("), false);
});

Deno.test("weekly has no direct driver_wallet_ledger insert", async () => {
  const src = await Deno.readTextFile(WEEKLY);
  assertEquals(src.includes('.from("driver_wallet_ledger").insert'), false);
});

Deno.test("weekly completion remains finalize_driver_payout_completion RPC", async () => {
  const src = await Deno.readTextFile(WEEKLY);
  assertStringIncludes(src, "finalize_driver_payout_completion");
});

Deno.test("weekly dry_run and ZERO_ELIGIBLE safe-skip markers remain", async () => {
  const src = await Deno.readTextFile(WEEKLY);
  assertStringIncludes(src, "dry_run");
  assertStringIncludes(src, "ZERO_ELIGIBLE_DRIVERS");
});
