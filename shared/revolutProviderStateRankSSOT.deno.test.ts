/**
 * Deno-native Slice 1 lock for Revolut provider-state ranking.
 * Run: deno test --no-check shared/revolutProviderStateRankSSOT.deno.test.ts
 */
import {
  assertEquals,
  assertFalse,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  isRevolutProviderStateRegression,
  revolutProviderStateRank,
} from "./revolutProviderStateRankSSOT.ts";

Deno.test("ranks terminal capture above authorisation", () => {
  assertEquals(
    revolutProviderStateRank("CAPTURED") > revolutProviderStateRank("AUTHORISED"),
    true,
  );
  assertEquals(revolutProviderStateRank("COMPLETED"), revolutProviderStateRank("CAPTURED"));
  assertEquals(revolutProviderStateRank("AUTHORIZED"), revolutProviderStateRank("AUTHORISED"));
});

Deno.test("weaker states regress after AUTHORISED", () => {
  assertEquals(isRevolutProviderStateRegression("AUTHORISED", "CANCELLED"), true);
  assertEquals(isRevolutProviderStateRegression("AUTHORISED", "FAILED"), true);
  assertEquals(isRevolutProviderStateRegression("AUTHORISED", "PAYMENT_FAILED"), true);
  assertEquals(isRevolutProviderStateRegression("AUTHORISED", "PENDING"), true);
  assertEquals(isRevolutProviderStateRegression("AUTHORISED", "AUTHORIZED"), false);
  assertEquals(isRevolutProviderStateRegression("AUTHORISED", "CAPTURED"), false);
});

Deno.test("PAYMENT_FAILED / DECLINED share FAILED rank and stick against PROCESSING", () => {
  assertEquals(revolutProviderStateRank("PAYMENT_FAILED"), revolutProviderStateRank("FAILED"));
  assertEquals(revolutProviderStateRank("DECLINED"), revolutProviderStateRank("FAILED"));
  assertEquals(isRevolutProviderStateRegression("FAILED", "PROCESSING"), true);
  assertEquals(isRevolutProviderStateRegression("DECLINED", "PENDING"), true);
});

Deno.test("unknown/empty prior is not a regression", () => {
  assertFalse(isRevolutProviderStateRegression(null, "CANCELLED"));
  assertFalse(isRevolutProviderStateRegression("AUTHORISED", ""));
});
