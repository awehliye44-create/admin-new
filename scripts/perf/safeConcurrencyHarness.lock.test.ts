/**
 * Batch O2 — safe concurrency harness guards.
 * Run: deno test --allow-read scripts/perf/safeConcurrencyHarness.lock.test.ts
 */
import {
  assertEquals,
  assertThrows,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { assertNotProductionUrl } from "./safeConcurrencyHarness.ts";

Deno.test("harness source refuses production wording and paid booking paths", async () => {
  const src = await Deno.readTextFile(
    new URL("./safeConcurrencyHarness.ts", import.meta.url),
  );
  assertStringIncludes(src, "NEVER pointed at production");
  assertStringIncludes(src, "NEVER creates paid bookings");
  assertStringIncludes(src, "ALLOW_STAGING_HTTP");
  assertEquals(src.includes("create-trip-after-payment"), false);
  assertEquals(src.includes("create-payment"), false);
});

Deno.test("assertNotProductionUrl blocks non-staging supabase hosts", () => {
  assertThrows(() => {
    assertNotProductionUrl("https://xyzcompany.supabase.co");
  });
});
