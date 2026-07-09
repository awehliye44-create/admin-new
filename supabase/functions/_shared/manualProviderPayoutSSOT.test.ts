import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  isManualBankPayoutProvider,
  isValidProviderReference,
  manualProviderEligiblePence,
  normalizeProviderReference,
} from "./manualProviderPayoutSSOT.ts";

Deno.test("isManualBankPayoutProvider identifies revolut", () => {
  assertEquals(isManualBankPayoutProvider("revolut"), true);
  assertEquals(isManualBankPayoutProvider("stripe"), false);
  assertEquals(isManualBankPayoutProvider(null), false);
});

Deno.test("manualProviderEligiblePence uses wallet minus in-flight", () => {
  assertEquals(
    manualProviderEligiblePence({ walletUnpaidPence: 5000, inFlightPayoutPence: 1000 }),
    4000,
  );
  assertEquals(
    manualProviderEligiblePence({ walletUnpaidPence: 500, payoutBlocked: true }),
    0,
  );
});

Deno.test("provider reference validation", () => {
  assertEquals(isValidProviderReference("ab"), false);
  assertEquals(isValidProviderReference("REV-12345"), true);
  assertEquals(normalizeProviderReference("  REF-1  "), "REF-1");
});
