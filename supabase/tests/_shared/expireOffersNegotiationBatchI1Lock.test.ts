/**
 * I-1 residual — negotiation batch + durable-assert throttle locks.
 * No TTL / cron / financial behaviour change.
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  EXPIRE_OFFERS_DURABLE_ASSERT_INTERVAL_MS_DEFAULT,
  indexRowsById,
  shouldAssertDurableLeaseNow,
  uniqueNonEmptyIds,
} from "../../functions/expire-offers/lib/expireOffersNegotiationBatchSSOT.ts";

const ROOT = new URL("../../", import.meta.url).pathname;

Deno.test("I-1 indexRowsById maps by trimmed id and skips blanks", () => {
  const map = indexRowsById([
    { id: " a ", status: "pending" },
    { id: "", status: "x" },
    { id: "b", status: "accepted" },
  ]);
  assertEquals(map.size, 2);
  assertEquals(map.get("a")?.status, "pending");
  assertEquals(map.get("b")?.status, "accepted");
});

Deno.test("I-1 uniqueNonEmptyIds dedupes and trims", () => {
  assertEquals(uniqueNonEmptyIds(["a", " a ", null, "", "b", "a"]), ["a", "b"]);
});

Deno.test("I-1 durable assert always when session fence not held", () => {
  assertEquals(
    shouldAssertDurableLeaseNow({
      nowMs: 500,
      lastAssertAtMs: 400,
      sessionFenceHeld: false,
      intervalMs: 1000,
    }),
    true,
  );
});

Deno.test("I-1 durable assert throttled while session fence held", () => {
  assertEquals(
    shouldAssertDurableLeaseNow({
      nowMs: 500,
      lastAssertAtMs: null,
      sessionFenceHeld: true,
    }),
    true,
  );
  assertEquals(
    shouldAssertDurableLeaseNow({
      nowMs: 500,
      lastAssertAtMs: 0,
      sessionFenceHeld: true,
      intervalMs: EXPIRE_OFFERS_DURABLE_ASSERT_INTERVAL_MS_DEFAULT,
    }),
    false,
  );
  assertEquals(
    shouldAssertDurableLeaseNow({
      nowMs: 1000,
      lastAssertAtMs: 0,
      sessionFenceHeld: true,
      intervalMs: EXPIRE_OFFERS_DURABLE_ASSERT_INTERVAL_MS_DEFAULT,
    }),
    true,
  );
});

Deno.test("I-1 expire-offers index batches negotiation guards and throttles durable assert", async () => {
  const src = await Deno.readTextFile(`${ROOT}functions/expire-offers/index.ts`);
  assertStringIncludes(src, "expireOffersNegotiationBatchSSOT");
  assertStringIncludes(src, "indexRowsById");
  assertStringIncludes(src, "shouldAssertDurableLeaseNow");
  assertStringIncludes(src, "uniqueNonEmptyIds");
  assertStringIncludes(src, "customerOfferGuards");
  assertStringIncludes(src, "timedOutOfferGuards");
  assertStringIncludes(src, "timedOutTripGuards");
  assertStringIncludes(src, "lastDurableAssertAtMs");
  // Durable assert retained — not removed
  assertStringIncludes(src, "assertExpireOffersLeaseOwner");
  // Session fence remains primary
  assertStringIncludes(src, "tryAcquireExpireOffersSessionFence");
  // No TTL / cron mutation in this patch surface
  assertEquals(src.includes("expires_at +"), false);
});
