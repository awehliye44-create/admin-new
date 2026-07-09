import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { isManualBankPayoutProvider } from "./manualProviderPayoutSSOT.ts";

Deno.test("revolut scope is manual provider payout", () => {
  assertEquals(isManualBankPayoutProvider("revolut"), true);
  assertEquals(isManualBankPayoutProvider("stripe"), false);
});
