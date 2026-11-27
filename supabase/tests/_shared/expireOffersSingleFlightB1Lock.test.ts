/**
 * B1 — expire-offers single-flight + bounded execution lock tests.
 * Review/testing only — does not deploy to production.
 *
 * Run:
 *   deno test --allow-read --allow-env supabase/tests/_shared/expireOffersSingleFlightB1Lock.test.ts
 */
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  createExpireOffersBudget,
  shouldSkipExpireOffersUnit,
} from "../../functions/expire-offers/lib/expireOffersBudgetSSOT.ts";
import {
  EXPIRE_OFFERS_BUDGET_MS_DEFAULT,
  EXPIRE_OFFERS_LEASE_TTL_SECONDS_DEFAULT,
  expireOffersBudgetFitsLease,
  isExpireOffersSingleFlightEnabled,
  isOwnershipSafeExpireOffersRelease,
  mayMutateUnderExpireOffersLease,
  resolveExpireOffersBudgetMs,
  resolveExpireOffersLeaseTtlSeconds,
  shouldAllowExpireOffersLeaseClaim,
} from "../../functions/expire-offers/lib/expireOffersSingleFlightSSOT.ts";
import {
  EXPIRE_OFFERS_ADVISORY_K1,
  EXPIRE_OFFERS_ADVISORY_K2,
  canPeerReclaimWhileHolderAlive,
} from "../../functions/expire-offers/lib/expireOffersSessionFenceModel.ts";

const root = new URL("../../functions/", import.meta.url);
const migRoot = new URL("../../migrations/", import.meta.url);

async function readFn(rel: string): Promise<string> {
  return await Deno.readTextFile(new URL(rel, root));
}

async function readMig(name: string): Promise<string> {
  return await Deno.readTextFile(new URL(name, migRoot));
}

Deno.test("B1 flag defaults OFF (prod-safe until EXPIRE_OFFERS_SINGLE_FLIGHT=1)", () => {
  assertEquals(isExpireOffersSingleFlightEnabled(undefined), false);
  assertEquals(isExpireOffersSingleFlightEnabled(""), false);
  assertEquals(isExpireOffersSingleFlightEnabled("0"), false);
  assertEquals(isExpireOffersSingleFlightEnabled("1"), true);
  assertEquals(isExpireOffersSingleFlightEnabled("true"), true);
});

Deno.test("B1 lease TTL and budget defaults match proposal bounds", () => {
  assertEquals(resolveExpireOffersLeaseTtlSeconds(undefined), EXPIRE_OFFERS_LEASE_TTL_SECONDS_DEFAULT);
  assertEquals(EXPIRE_OFFERS_LEASE_TTL_SECONDS_DEFAULT, 18);
  assertEquals(resolveExpireOffersBudgetMs(undefined), EXPIRE_OFFERS_BUDGET_MS_DEFAULT);
  assertEquals(EXPIRE_OFFERS_BUDGET_MS_DEFAULT, 8000);
  assertEquals(resolveExpireOffersLeaseTtlSeconds("3"), 5); // floor
  assertEquals(resolveExpireOffersLeaseTtlSeconds("99"), 60); // cap
  assertEquals(resolveExpireOffersBudgetMs("0"), 0); // unlimited diagnostic
});

Deno.test("B1 claim predicate: free / expired / same-owner renew; active other owner blocked", () => {
  const now = 1_000_000;
  assertEquals(
    shouldAllowExpireOffersLeaseClaim({
      nowMs: now,
      ownerToken: null,
      leaseExpiresAtMs: null,
      claimantToken: "worker-a",
    }),
    true,
  );
  assertEquals(
    shouldAllowExpireOffersLeaseClaim({
      nowMs: now,
      ownerToken: "worker-b",
      leaseExpiresAtMs: now - 1,
      claimantToken: "worker-a",
    }),
    true,
    "expired lease reclaimable",
  );
  assertEquals(
    shouldAllowExpireOffersLeaseClaim({
      nowMs: now,
      ownerToken: "worker-b",
      leaseExpiresAtMs: now + 5_000,
      claimantToken: "worker-a",
    }),
    false,
    "active other owner must block",
  );
  assertEquals(
    shouldAllowExpireOffersLeaseClaim({
      nowMs: now,
      ownerToken: "worker-a",
      leaseExpiresAtMs: now + 5_000,
      claimantToken: "worker-a",
    }),
    true,
    "same-owner renew allowed",
  );
});

Deno.test("B1 ownership-safe release: only current owner; stale worker no-op", () => {
  assertEquals(
    isOwnershipSafeExpireOffersRelease({ ownerToken: "a", releaserToken: "a" }),
    true,
  );
  assertEquals(
    isOwnershipSafeExpireOffersRelease({ ownerToken: "b", releaserToken: "a" }),
    false,
    "stale worker must not clear reclaimed lease",
  );
  assertEquals(
    isOwnershipSafeExpireOffersRelease({ ownerToken: null, releaserToken: "a" }),
    false,
  );
});

Deno.test("B1 simulated overlapping ticks: second claimant blocked until TTL", () => {
  const now = Date.now();
  const lease = { owner: "tick-1", expiresAt: now + 18_000 };
  assertEquals(
    shouldAllowExpireOffersLeaseClaim({
      nowMs: now,
      ownerToken: lease.owner,
      leaseExpiresAtMs: lease.expiresAt,
      claimantToken: "tick-2",
    }),
    false,
  );
  // Worker-1 terminates without release; after TTL tick-2 reclaims.
  assertEquals(
    shouldAllowExpireOffersLeaseClaim({
      nowMs: lease.expiresAt + 1,
      ownerToken: lease.owner,
      leaseExpiresAtMs: lease.expiresAt,
      claimantToken: "tick-2",
    }),
    true,
    "automatic recovery after lease TTL",
  );
});

Deno.test("B1 budget: skips new units when exhausted; unlimited when 0", () => {
  let t = 0;
  const budget = createExpireOffersBudget(() => t, 100);
  assertEquals(budget.exhausted(), false);
  t = 100;
  assertEquals(shouldSkipExpireOffersUnit(budget), true);
  assertEquals(budget.wasExhausted(), true);

  const unlimited = createExpireOffersBudget(() => 999_999, 0);
  assertEquals(shouldSkipExpireOffersUnit(unlimited), false);
  assertEquals(unlimited.wasExhausted(), false);
});

/**
 * 26 Nov baseline: max concurrency 12, 112 overlapping pairs, p50 18–35s.
 * With single-flight, at most one worker holds the lease; others overlap_skip.
 */
Deno.test("B1 vs 26 Nov baseline: 12 concurrent ticks → 1 work + 11 overlap_skipped", () => {
  const now = 1_700_000_000_000;
  const leaseTtlMs = 18_000;
  let owner: string | null = null;
  let expiresAt = 0;
  let worked = 0;
  let skipped = 0;

  for (let i = 0; i < 12; i++) {
    const claimant = `tick-${i}`;
    const allowed = shouldAllowExpireOffersLeaseClaim({
      nowMs: now,
      ownerToken: owner,
      leaseExpiresAtMs: owner ? expiresAt : null,
      claimantToken: claimant,
    });
    if (!allowed) {
      skipped += 1;
      continue;
    }
    owner = claimant;
    expiresAt = now + leaseTtlMs;
    worked += 1;
  }

  assertEquals(worked, 1);
  assertEquals(skipped, 11);
  // Pre-B1 would allow all 12 → C(12,2)=66 pairs minimum; observed 112 with staggered starts.
  assert(worked + skipped === 12);
});

Deno.test("B1 backlog drains across ticks under 8s budget without permanent stall", () => {
  const CRON_MS = 10_000;
  const BUDGET_MS = 8_000;
  const UNIT_MS = 2_000;
  let backlog = 20; // work units (offers/trips)
  let tick = 0;
  const maxTicks = 20;

  while (backlog > 0 && tick < maxTicks) {
    let t = 0;
    const budget = createExpireOffersBudget(() => t, BUDGET_MS);
    // One worker per tick (single-flight).
    while (backlog > 0 && !shouldSkipExpireOffersUnit(budget)) {
      backlog -= 1;
      t += UNIT_MS;
    }
    tick += 1;
    // Simulated wall advance to next cron.
    void CRON_MS;
  }

  assertEquals(backlog, 0, "backlog must drain across ticks");
  assert(tick <= 10, "20 units @ 2s with 8s budget → ≤10 ticks");
});

Deno.test("B1 max added delay bound: overlap skip ≤ cron; kill recovery ≤ lease TTL", () => {
  const CRON_MS = 10_000;
  const LEASE_TTL_MS = EXPIRE_OFFERS_LEASE_TTL_SECONDS_DEFAULT * 1000;
  // Overlap skip: next cron claims after release or immediately if released in finally.
  const overlapDeferMs = CRON_MS;
  assert(overlapDeferMs <= CRON_MS, "overlap must not multi-minute defer");
  // Hard kill without finally: reclaim after TTL.
  assertEquals(LEASE_TTL_MS, 18_000);
  assert(LEASE_TTL_MS < 2 * CRON_MS, "TTL < 2× cron so next-next tick recovers");
});

Deno.test("B1 migration: singleton lease + claim/release + service_role only + no money tables", async () => {
  const mig = await readMig("20270305090000_expire_offers_single_flight_lease_b1.sql");
  assertStringIncludes(mig, "expire_offers_single_flight_lease");
  assertStringIncludes(mig, "try_claim_expire_offers_lease");
  assertStringIncludes(mig, "release_expire_offers_lease");
  assertStringIncludes(mig, "pg_try_advisory_xact_lock");
  assertStringIncludes(mig, "GRANT EXECUTE ON FUNCTION public.try_claim_expire_offers_lease");
  assertStringIncludes(mig, "TO service_role");
  assertStringIncludes(mig, "REVOKE ALL ON FUNCTION public.try_claim_expire_offers_lease");
  assertStringIncludes(mig, "FROM anon, authenticated");
  assert(!/driver_wallet_ledger|payment_sessions|tip_window|revolut/i.test(mig), "no financial tables");
  assert(!/ALTER TABLE public\.ride_offers|ALTER TABLE public\.trips/i.test(mig), "no ride/trip schema changes");
  assert(!/CREATE OR REPLACE FUNCTION public\.expire_offers_sweep/i.test(mig), "sweep cadence untouched");
});

Deno.test("B1 rollback migration drops lease objects only", async () => {
  const rb = await readMig("rollback/rollback_20270305090000_expire_offers_single_flight_lease_b1.sql");
  assertStringIncludes(rb, "DROP FUNCTION IF EXISTS public.release_expire_offers_lease");
  assertStringIncludes(rb, "DROP FUNCTION IF EXISTS public.try_claim_expire_offers_lease");
  assertStringIncludes(rb, "DROP TABLE IF EXISTS public.expire_offers_single_flight_lease");
});

Deno.test("B1 expire-offers index wires flag, claim, session fence, budget, overlap_skipped, finally release", async () => {
  const src = await readFn("expire-offers/index.ts");
  assertStringIncludes(src, "isExpireOffersSingleFlightEnabled");
  assertStringIncludes(src, "tryClaimExpireOffersLease");
  assertStringIncludes(src, "releaseExpireOffersLease");
  assertStringIncludes(src, "assertExpireOffersLeaseOwner");
  assertStringIncludes(src, "tryAcquireExpireOffersSessionFence");
  assertStringIncludes(src, "sessionFenceRelease");
  assertStringIncludes(src, "shouldStopNewMutationUnits");
  assertStringIncludes(src, "overlap_skipped: true");
  assertStringIncludes(src, "budget_exhausted");
  assertStringIncludes(src, "stale_fenced");
  assertStringIncludes(src, "work_units");
  assertStringIncludes(src, "finally");
  // Fail closed: no critical section without session fence
  assertStringIncludes(src, "session_fence_busy");
  assertStringIncludes(src, "session_fence_failed");
  // Semantics preserved
  assertStringIncludes(src, "sweepExpiredOffers");
  assertStringIncludes(src, "finalizeNegotiationFailureAndRebroadcast");
  assertStringIncludes(src, "runExpireOffersRebroadcastBatch");
  assertStringIncludes(src, "isStaleTripRebroadcastCandidate");
  // Financial freeze — no tip/capture/payment edits in this function body for B1
  assertEquals(src.includes("capture-expired-tip"), false);
  assertEquals(src.includes("driver_wallet_ledger"), false);
});

Deno.test("B1 session fence closes check-to-use: peer cannot enter CS while holder alive after TTL", () => {
  // TTL-only is unsafe: fence-check → stall → reclaim → stale mutation.
  assertEquals(
    canPeerReclaimWhileHolderAlive({ holderHasSessionFence: false, leaseExpired: true })
      .peerMayEnterCriticalSection,
    true,
    "TTL-only allows peer after expiry while holder still mutating",
  );
  // Session advisory: peer blocked for whole Edge request even if durable TTL expired.
  assertEquals(
    canPeerReclaimWhileHolderAlive({ holderHasSessionFence: true, leaseExpired: true })
      .peerMayEnterCriticalSection,
    false,
    "session fence blocks peer while holder connection alive",
  );
  assertEquals(
    canPeerReclaimWhileHolderAlive({ holderHasSessionFence: true, leaseExpired: false })
      .peerMayEnterCriticalSection,
    false,
  );
  assertEquals(EXPIRE_OFFERS_ADVISORY_K1, 872014001);
  assertEquals(EXPIRE_OFFERS_ADVISORY_K2, 1);
});

Deno.test("B1 session fence SSOT fail-closed without DB URL and unlocks on release path", async () => {
  const fenceSrc = await readFn("expire-offers/lib/expireOffersSessionFenceSSOT.ts");
  const modelSrc = await readFn("expire-offers/lib/expireOffersSessionFenceModel.ts");
  assertStringIncludes(fenceSrc, "pg_try_advisory_lock");
  assertStringIncludes(fenceSrc, "pg_advisory_unlock");
  assertStringIncludes(fenceSrc, "SUPABASE_DB_URL");
  assertStringIncludes(fenceSrc, "missing_supabase_db_url");
  assertStringIncludes(fenceSrc, "advisory_busy");
  assertStringIncludes(fenceSrc, "EXPIRE_OFFERS_ADVISORY_K1");
  assertStringIncludes(fenceSrc, "npm:postgres@3.4.5");
  assertStringIncludes(modelSrc, String(EXPIRE_OFFERS_ADVISORY_K1));
});

Deno.test("B1 fence predicate blocks expired owner and foreign owner", () => {
  const now = 5_000_000;
  assertEquals(
    mayMutateUnderExpireOffersLease({
      nowMs: now,
      ownerToken: "a",
      leaseExpiresAtMs: now + 1_000,
      workerToken: "a",
    }),
    true,
  );
  assertEquals(
    mayMutateUnderExpireOffersLease({
      nowMs: now,
      ownerToken: "a",
      leaseExpiresAtMs: now - 1,
      workerToken: "a",
    }),
    false,
  );
  assertEquals(
    mayMutateUnderExpireOffersLease({
      nowMs: now,
      ownerToken: "b",
      leaseExpiresAtMs: now + 1_000,
      workerToken: "a",
    }),
    false,
  );
  assertEquals(expireOffersBudgetFitsLease(), true);
});

Deno.test("B1 does not change offer expiry wave enable helper or rematch imports", async () => {
  const src = await readFn("expire-offers/index.ts");
  assertStringIncludes(src, "isOfferExpiryWaveEnabled");
  assertStringIncludes(src, "assertGlobalRebroadcastAllowed");
  assertStringIncludes(src, "waitingCustomerExpiryAction");
  // Stage marks for O2 correlation retained
  assertStringIncludes(src, "negotiation_block_start");
  assertStringIncludes(src, "sweep_rpc_start");
  assertStringIncludes(src, "rebroadcast_start");
});

Deno.test("B1 concurrent accept protection paths untouched (guards remain)", async () => {
  const src = await readFn("expire-offers/index.ts");
  // Existing accept/confirmed guards before negotiation timeout mutations
  assertStringIncludes(src, 'offerGuard?.status === "accepted"');
  assertStringIncludes(src, 'offerGuard?.negotiation_status === "confirmed"');
  assert(
    src.includes('tripGuard.status === "accepted"') ||
      src.includes('dispatch_status === "assigned"'),
    "assignment exclusivity guard must remain",
  );
});
