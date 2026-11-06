/**
 * Capacity lock: expire-offers drains next waves with bounded concurrency;
 * auto-dispatch rate-limits by trip (service-role), not shared egress IP.
 *
 * Run:
 *   deno test --allow-read --allow-env supabase/tests/_shared/expireOffersRebroadcastCapacityLock.test.ts
 */
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { mapWithConcurrency } from "../../functions/_shared/mapWithConcurrency.ts";
import {
  AUTO_DISPATCH_PER_TRIP_RATE_LIMIT,
  AUTO_DISPATCH_SERVICE_GLOBAL_RATE_LIMIT,
  AUTO_DISPATCH_SERVICE_GLOBAL_RL_ID,
  autoDispatchTripRateLimitId,
} from "../../functions/_shared/autoDispatchRateLimitSSOT.ts";
import {
  EXPIRE_OFFERS_REBROADCAST_CONCURRENCY_DEFAULT,
  EXPIRE_OFFERS_REBROADCAST_CONCURRENCY_MAX,
  rebroadcastSourceForTrigger,
  resolveExpireOffersRebroadcastConcurrency,
  runExpireOffersRebroadcastBatch,
} from "../../functions/_shared/expireOffersRebroadcastRunner.ts";

Deno.test("mapWithConcurrency preserves order and respects the concurrency ceiling", async () => {
  let inFlight = 0;
  let peak = 0;
  const startedAt = Date.now();

  const results = await mapWithConcurrency(
    [1, 2, 3, 4, 5, 6],
    2,
    async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 30));
      inFlight -= 1;
      return n * 10;
    },
  );

  assertEquals(results, [10, 20, 30, 40, 50, 60]);
  assertEquals(peak <= 2, true);
  // Serial would be ~180ms; concurrency 2 should finish sooner.
  assertEquals(Date.now() - startedAt < 160, true);
});

Deno.test("resolveExpireOffersRebroadcastConcurrency clamps env and defaults to 8", () => {
  assertEquals(resolveExpireOffersRebroadcastConcurrency(""), EXPIRE_OFFERS_REBROADCAST_CONCURRENCY_DEFAULT);
  assertEquals(resolveExpireOffersRebroadcastConcurrency(undefined), EXPIRE_OFFERS_REBROADCAST_CONCURRENCY_DEFAULT);
  assertEquals(resolveExpireOffersRebroadcastConcurrency("4"), 4);
  assertEquals(resolveExpireOffersRebroadcastConcurrency("99"), EXPIRE_OFFERS_REBROADCAST_CONCURRENCY_MAX);
  assertEquals(resolveExpireOffersRebroadcastConcurrency("0"), 1);
  assertEquals(resolveExpireOffersRebroadcastConcurrency("nope"), EXPIRE_OFFERS_REBROADCAST_CONCURRENCY_DEFAULT);
});

Deno.test("rebroadcastSourceForTrigger keeps expire-offers policy context labels", () => {
  assertEquals(rebroadcastSourceForTrigger("offer_expired"), "expire-offers:offer_expired_sweep");
  assertEquals(rebroadcastSourceForTrigger("search_window_recheck"), "expire-offers:search_window_recheck");
  assertEquals(
    rebroadcastSourceForTrigger("vehicle_type_selected_stuck_recovery"),
    "expire-offers:vehicle_type_selected_stuck_recovery",
  );
  assertEquals(rebroadcastSourceForTrigger("other"), "expire-offers:stale_trip_scan");
});

Deno.test("runExpireOffersRebroadcastBatch invokes auto-dispatch in parallel up to concurrency", async () => {
  let inFlight = 0;
  let peak = 0;
  const seen: string[] = [];

  const results = await runExpireOffersRebroadcastBatch({
    supabase: {},
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "svc",
    concurrency: 3,
    invocations: [
      { tripId: "t1", body: { trip_id: "t1", force_rebroadcast: true, trigger_reason: "offer_expired" } },
      { tripId: "t2", body: { trip_id: "t2", force_rebroadcast: true, trigger_reason: "offer_expired" } },
      { tripId: "t3", body: { trip_id: "t3", force_rebroadcast: true, trigger_reason: "offer_expired" } },
      { tripId: "t4", body: { trip_id: "t4", force_rebroadcast: true, trigger_reason: "stale_trip_scan" } },
    ],
    assertRebroadcastAllowed: async () => true,
    loadDispatchTripContext: async (_sb, tripId) => ({ tripId }),
    invokeAutoDispatch: async ({ body }) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      seen.push(body.trip_id);
      await new Promise((r) => setTimeout(r, 40));
      inFlight -= 1;
      return {
        ok: true,
        httpStatus: 200,
        outcome: "successful_dispatch",
        errorCode: null,
        responseBody: { success: true, offers_created: 1 },
        logPayload: {},
      };
    },
  });

  assertEquals(results.length, 4);
  assertEquals(results.every((r) => r.success), true);
  assertEquals(seen.sort(), ["t1", "t2", "t3", "t4"]);
  assertEquals(peak <= 3, true);
  assertEquals(peak >= 2, true);
});

Deno.test("runExpireOffersRebroadcastBatch omits policy-blocked trips (same as prior continue)", async () => {
  let invokes = 0;
  const results = await runExpireOffersRebroadcastBatch({
    supabase: {},
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "svc",
    concurrency: 4,
    invocations: [
      { tripId: "ok", body: { trip_id: "ok", force_rebroadcast: true, trigger_reason: "offer_expired" } },
      { tripId: "blocked", body: { trip_id: "blocked", force_rebroadcast: true, trigger_reason: "offer_expired" } },
    ],
    assertRebroadcastAllowed: async (_sb, tripId) => tripId !== "blocked",
    loadDispatchTripContext: async (_sb, tripId) => ({ tripId }),
    invokeAutoDispatch: async () => {
      invokes += 1;
      return {
        ok: true,
        httpStatus: 200,
        outcome: "successful_dispatch",
        errorCode: null,
        responseBody: { success: true },
        logPayload: {},
      };
    },
  });

  assertEquals(invokes, 1);
  assertEquals(results.map((r) => r.trip_id), ["ok"]);
});

Deno.test("auto-dispatch rate-limit SSOT is trip-scoped with a service global ceiling", () => {
  assertEquals(AUTO_DISPATCH_PER_TRIP_RATE_LIMIT.keyPrefix, "auto-dispatch:trip");
  assertEquals(AUTO_DISPATCH_PER_TRIP_RATE_LIMIT.limit, 30);
  assertEquals(AUTO_DISPATCH_SERVICE_GLOBAL_RATE_LIMIT.keyPrefix, "auto-dispatch:service");
  assertEquals(AUTO_DISPATCH_SERVICE_GLOBAL_RATE_LIMIT.limit, 600);
  assertEquals(AUTO_DISPATCH_SERVICE_GLOBAL_RL_ID, "global");
  assertEquals(autoDispatchTripRateLimitId("  abc  "), "abc");
  assertEquals(autoDispatchTripRateLimitId(""), "missing-trip-id");
  assertEquals(autoDispatchTripRateLimitId(null), "missing-trip-id");
});

Deno.test("source lock: expire-offers uses bounded rebroadcast runner", async () => {
  const expire = await Deno.readTextFile(
    new URL("../../functions/expire-offers/index.ts", import.meta.url),
  );
  assert(expire.includes("runExpireOffersRebroadcastBatch"));
  assert(expire.includes("resolveExpireOffersRebroadcastConcurrency"));
  // Must not regress to a serial for-await of invokeAutoDispatchWithServiceRole in the main batch.
  assertEquals(
    /for \(const \{ tripId, body \} of allRebroadcastInvocations\)/.test(expire),
    false,
  );
});

Deno.test("source lock: auto-dispatch auth-then trip/global RL — not shared IP", async () => {
  const autoDispatch = await Deno.readTextFile(
    new URL("../../functions/auto-dispatch/index.ts", import.meta.url),
  );
  assert(autoDispatch.includes("requireServiceRole(req, supabaseKey)"));
  assert(autoDispatch.includes("AUTO_DISPATCH_PER_TRIP_RATE_LIMIT"));
  assert(autoDispatch.includes("AUTO_DISPATCH_SERVICE_GLOBAL_RATE_LIMIT"));
  assert(autoDispatch.includes("autoDispatchTripRateLimitId"));
  assertEquals(autoDispatch.includes("getClientIP"), false);
  assertEquals(autoDispatch.includes("Rate limit exceeded for IP"), false);
});

Deno.test("mapWithConcurrency rejects nothing on worker throw — surfaces via Promise", async () => {
  await assertRejects(
    () =>
      mapWithConcurrency([1], 1, async () => {
        throw new Error("boom");
      }),
    Error,
    "boom",
  );
});
