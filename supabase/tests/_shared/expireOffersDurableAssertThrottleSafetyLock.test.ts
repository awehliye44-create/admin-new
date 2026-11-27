/**
 * I-1 durable-assert throttle — safety proofs (session fence remains primary).
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  EXPIRE_OFFERS_DURABLE_ASSERT_INTERVAL_MS_DEFAULT,
  shouldAssertDurableLeaseNow,
} from "../../functions/expire-offers/lib/expireOffersNegotiationBatchSSOT.ts";
import { canPeerReclaimWhileHolderAlive } from "../../functions/expire-offers/lib/expireOffersSessionFenceModel.ts";

Deno.test("I-1 throttle never skips durable assert when session fence is absent", () => {
  // Without session fence, durable assert is required every unit.
  assertEquals(
    shouldAssertDurableLeaseNow({
      nowMs: 50,
      lastAssertAtMs: 0,
      sessionFenceHeld: false,
      intervalMs: 10_000,
    }),
    true,
  );
});

Deno.test("I-1 throttle only applies while session advisory fence is held", () => {
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
      nowMs: EXPIRE_OFFERS_DURABLE_ASSERT_INTERVAL_MS_DEFAULT,
      lastAssertAtMs: 0,
      sessionFenceHeld: true,
      intervalMs: EXPIRE_OFFERS_DURABLE_ASSERT_INTERVAL_MS_DEFAULT,
    }),
    true,
  );
});

Deno.test("I-1 peer cannot reclaim critical section while holder session fence alive", () => {
  // Stale-worker / overlapping authoritative processing is closed by advisory fence,
  // not by durable TTL alone — throttle is safe only because this remains true.
  assertEquals(
    canPeerReclaimWhileHolderAlive({
      holderHasSessionFence: true,
      leaseExpired: true,
    }).peerMayEnterCriticalSection,
    false,
  );
  assertEquals(
    canPeerReclaimWhileHolderAlive({
      holderHasSessionFence: false,
      leaseExpired: true,
    }).peerMayEnterCriticalSection,
    true,
  );
});
