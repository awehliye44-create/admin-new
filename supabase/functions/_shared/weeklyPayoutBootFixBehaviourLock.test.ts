import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const WEEKLY = new URL("../admin-execute-weekly-payout-occurrence/index.ts", import.meta.url);
const COMPLETION = new URL("./driverPayoutCompletionSSOT.ts", import.meta.url);
const RELAY = new URL("./revolutBusinessRelayClient.ts", import.meta.url);

Deno.test("status helper contract: revolut_pay_called is always false", async () => {
  const src = await Deno.readTextFile(RELAY);
  const fnStart = src.indexOf("export async function relayApprovedDriverPayoutPaymentStatus");
  const slice = src.slice(fnStart, fnStart + 2500);
  assertStringIncludes(slice, "revolut_pay_called: false");
  assertEquals(slice.includes("/pay"), false);
});

Deno.test("weekly retains status and pay helpers", async () => {
  const src = await Deno.readTextFile(WEEKLY);
  assertEquals(src.includes("relayApprovedDriverPayoutPaymentStatus"), true);
  assertEquals(src.includes("relayApprovedDriverPayoutPayment({"), true);
});

Deno.test("completion SSOT still owns mayFinaliseFromProviderState", async () => {
  const src = await Deno.readTextFile(COMPLETION);
  assertStringIncludes(src, "mayFinaliseFromProviderState");
  assertStringIncludes(src, "isCanonicalProviderCompleted");
});

Deno.test("weekly cron auth markers present (no body-supplied role trust)", async () => {
  const src = await Deno.readTextFile(WEEKLY);
  assertStringIncludes(src, "assertCronOrServiceRoleAuth");
  assertEquals(src.includes("body.role"), false);
});
