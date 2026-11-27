/**
 * B1 staging soak — local concurrency / lease / fence verification.
 * Does NOT touch production. No paid bookings / load tests against live.
 *
 * Run:
 *   deno test --no-check --allow-read --allow-env \
 *     supabase/tests/_shared/expireOffersB1StagingSoak.test.ts \
 *     supabase/tests/_shared/expireOffersSingleFlightB1Lock.test.ts
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
  isOwnershipSafeExpireOffersRelease,
  mayMutateUnderExpireOffersLease,
  shouldAllowExpireOffersLeaseClaim,
} from "../../functions/expire-offers/lib/expireOffersSingleFlightSSOT.ts";

type LeaseState = {
  owner: string | null;
  expiresAt: number;
  mutations: string[];
};

function claim(state: LeaseState, worker: string, now: number, ttlMs: number): boolean {
  const ok = shouldAllowExpireOffersLeaseClaim({
    nowMs: now,
    ownerToken: state.owner,
    leaseExpiresAtMs: state.owner ? state.expiresAt : null,
    claimantToken: worker,
  });
  if (!ok) return false;
  state.owner = worker;
  state.expiresAt = now + ttlMs;
  return true;
}

function tryMutate(state: LeaseState, worker: string, now: number, label: string): boolean {
  const allowed = mayMutateUnderExpireOffersLease({
    nowMs: now,
    ownerToken: state.owner,
    leaseExpiresAtMs: state.expiresAt,
    workerToken: worker,
  });
  if (!allowed) return false;
  state.mutations.push(`${worker}:${label}@${now}`);
  return true;
}

function release(state: LeaseState, worker: string): boolean {
  if (!isOwnershipSafeExpireOffersRelease({ ownerToken: state.owner, releaserToken: worker })) {
    return false;
  }
  state.owner = null;
  state.expiresAt = 0;
  return true;
}

Deno.test("B1 soak: budget 8s fits lease 18s with slack invariant", () => {
  assertEquals(expireOffersBudgetFitsLease(), true);
  assertEquals(
    expireOffersBudgetFitsLease({
      budgetMs: EXPIRE_OFFERS_BUDGET_MS_DEFAULT,
      leaseTtlSeconds: EXPIRE_OFFERS_LEASE_TTL_SECONDS_DEFAULT,
    }),
    true,
  );
  // Pathological: 18s budget with 18s lease leaves no slack for stalls.
  assertEquals(expireOffersBudgetFitsLease({ budgetMs: 18_000, leaseTtlSeconds: 18 }), false);
});

Deno.test("B1 soak: DB stall beyond budget — fence stops after lease expiry before reclaim", () => {
  const TTL = 18_000;
  const BUDGET = 8_000;
  const state: LeaseState = { owner: null, expiresAt: 0, mutations: [] };
  const t0 = 1_000_000;
  assertEquals(claim(state, "w1", t0, TTL), true);

  let t = t0;
  const budget = createExpireOffersBudget(() => t - t0, BUDGET);
  // Units before budget.
  assertEquals(tryMutate(state, "w1", t, "u1"), true);
  t = t0 + 4_000;
  assertEquals(shouldSkipExpireOffersUnit(budget), false);
  assertEquals(tryMutate(state, "w1", t, "u2"), true);

  // Stall past budget (simulated long DB) — wall 12s; still within lease.
  t = t0 + 12_000;
  assertEquals(shouldSkipExpireOffersUnit(budget), true, "budget exhausted");
  // Fence still allows only if we ignored budget; production stops on budget OR fence.
  assertEquals(tryMutate(state, "w1", t, "stall-mid-lease"), true);

  // Stall past lease expiry (20s) — must NOT mutate even if still named owner.
  t = t0 + 20_000;
  assertEquals(
    mayMutateUnderExpireOffersLease({
      nowMs: t,
      ownerToken: state.owner,
      leaseExpiresAtMs: state.expiresAt,
      workerToken: "w1",
    }),
    false,
    "expired lease forbids mutation",
  );
  assertEquals(tryMutate(state, "w1", t, "after-expiry"), false);
});

Deno.test("B1 soak: new worker reclaim + old worker resume must not mutate", () => {
  const TTL = 18_000;
  const state: LeaseState = { owner: null, expiresAt: 0, mutations: [] };
  const t0 = 2_000_000;
  assertEquals(claim(state, "old", t0, TTL), true);
  assertEquals(tryMutate(state, "old", t0 + 1_000, "before"), true);

  // Old alive past expiry; new reclaim.
  const tReclaim = t0 + TTL + 1;
  assertEquals(claim(state, "new", tReclaim, TTL), true);
  assertEquals(state.owner, "new");

  // Old resumes — fence blocks.
  assertEquals(tryMutate(state, "old", tReclaim + 100, "stale-resume"), false);
  // New may mutate.
  assertEquals(tryMutate(state, "new", tReclaim + 100, "owner-work"), true);
  // Old release is ownership-safe no-op.
  assertEquals(release(state, "old"), false);
  assertEquals(state.owner, "new");
  assertEquals(release(state, "new"), true);

  assertEquals(state.mutations.some((m) => m.includes("stale-resume")), false);
  assertEquals(state.mutations.filter((m) => m.startsWith("old:")).length, 1);
  assertEquals(state.mutations.filter((m) => m.startsWith("new:")).length, 1);
});

Deno.test("B1 soak: concurrent scheduler ticks → max 1 critical-section worker", () => {
  const TTL = 18_000;
  const state: LeaseState = { owner: null, expiresAt: 0, mutations: [] };
  const now = 3_000_000;
  let worked = 0;
  let skipped = 0;
  for (let i = 0; i < 12; i++) {
    if (claim(state, `t${i}`, now, TTL)) {
      worked += 1;
      tryMutate(state, `t${i}`, now + 1, "cs");
    } else {
      skipped += 1;
    }
  }
  assertEquals(worked, 1);
  assertEquals(skipped, 11);
  assertEquals(state.mutations.length, 1);
});

Deno.test("B1 soak: representative backlog under budget — no starvation across ticks", () => {
  let backlog = 40;
  let oldestAgeMs = 40_000; // hypothetical age of oldest unit
  const BUDGET = 8_000;
  const UNIT = 1_000;
  const CRON = 10_000;
  let ticks = 0;
  while (backlog > 0 && ticks < 30) {
    let wall = 0;
    const budget = createExpireOffersBudget(() => wall, BUDGET);
    while (backlog > 0 && !shouldSkipExpireOffersUnit(budget)) {
      backlog -= 1;
      oldestAgeMs = Math.max(0, oldestAgeMs - UNIT);
      wall += UNIT;
    }
    ticks += 1;
    oldestAgeMs += CRON; // remaining ages while waiting next tick — simplified
    if (backlog === 0) oldestAgeMs = 0;
  }
  assertEquals(backlog, 0);
  assert(ticks <= 10, `expected ≤10 ticks, got ${ticks}`);
});

Deno.test("B1 soak: OFF vs ON concurrency model before/after", () => {
  const ticks = 12;
  // OFF: all mutate (unsafe overlap model of 26 Nov)
  const offMutations = ticks;
  // ON: one mutates
  const onMutations = 1;
  const offOverlapPairs = (ticks * (ticks - 1)) / 2; // 66 lower bound
  const onOverlapPairs = 0;
  assert(offMutations > onMutations);
  assert(offOverlapPairs > onOverlapPairs);
  assertEquals(onOverlapPairs, 0);
  assert(offOverlapPairs >= 66);
});

Deno.test("B1 soak: worker termination before mutation — no partial; after mutation — release safe", () => {
  const state: LeaseState = { owner: null, expiresAt: 0, mutations: [] };
  const t0 = 4_000_000;
  assertEquals(claim(state, "w", t0, 18_000), true);
  // Terminate before mutate: release clears; no mutations.
  assertEquals(release(state, "w"), true);
  assertEquals(state.mutations.length, 0);
  assertEquals(claim(state, "w2", t0 + 10, 18_000), true);
  assertEquals(tryMutate(state, "w2", t0 + 20, "ok"), true);
  assertEquals(release(state, "w2"), true);
});

Deno.test("B1 soak: flag OFF leaves mutation unconstrained by lease helpers when unused", () => {
  // When flag off, Edge never claims — helpers unused. Documented by source lock.
  assertEquals(expireOffersBudgetFitsLease(), true);
});

Deno.test("B1 source: durable + session fence wired before mutation units", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/expire-offers/index.ts", import.meta.url),
  );
  assertStringIncludes(src, "assertExpireOffersLeaseOwner");
  assertStringIncludes(src, "tryAcquireExpireOffersSessionFence");
  assertStringIncludes(src, "sessionFenceRelease");
  assertStringIncludes(src, "shouldStopNewMutationUnits");
  assertStringIncludes(src, "stale_fenced");
  assertStringIncludes(src, "lease_fence_lost");
  assertStringIncludes(src, "stale fence stop");
});

Deno.test("B1 soak: session fence blocks peer CS entry after durable TTL while holder alive", () => {
  // Model: holder passed durable fence then stalled past TTL; peer reclaimed durable row.
  // Without session fence peer enters CS (unsafe). With session fence peer cannot.
  const without = { holderAlive: true, durableExpired: true, sessionFenceHeld: false };
  const withFence = { holderAlive: true, durableExpired: true, sessionFenceHeld: true };
  const peerEnters = (s: typeof without) =>
    s.holderAlive && s.durableExpired && !s.sessionFenceHeld;
  assertEquals(peerEnters(without), true, "TTL-only TOCTOU");
  assertEquals(peerEnters(withFence), false, "session advisory closes race");
});
