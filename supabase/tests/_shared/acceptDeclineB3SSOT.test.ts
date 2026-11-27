/**
 * B3 Accept/Decline SSOT — flag default OFF + OFF/ON workload model.
 *
 * Run: deno test --no-check --allow-read --allow-env \
 *   supabase/tests/_shared/acceptDeclineB3SSOT.test.ts
 */
import {
  assertEquals,
  assert,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ACCEPT_DECLINE_B3_FLAG,
  isAcceptDeclineB3Enabled,
  measureAcceptDeclineB3Workload,
} from "../../functions/_shared/acceptDeclineB3SSOT.ts";

Deno.test("B3 flag defaults OFF", () => {
  assertEquals(isAcceptDeclineB3Enabled(undefined), false);
  assertEquals(isAcceptDeclineB3Enabled(null), false);
  assertEquals(isAcceptDeclineB3Enabled(""), false);
  assertEquals(isAcceptDeclineB3Enabled("0"), false);
  assertEquals(ACCEPT_DECLINE_B3_FLAG, "ACCEPT_DECLINE_B3");
});

Deno.test("B3 flag accepts 1/true/on/yes", () => {
  assertEquals(isAcceptDeclineB3Enabled("1"), true);
  assertEquals(isAcceptDeclineB3Enabled("true"), true);
  assertEquals(isAcceptDeclineB3Enabled("ON"), true);
  assertEquals(isAcceptDeclineB3Enabled("yes"), true);
});

Deno.test("identical workload: B3 ON reduces primary path vs OFF", () => {
  const base = {
    eligibilityMs: 180,
    offerLookupMs: 120,
    holdOrMarketplaceMs: 90,
    preRpcParallelMembersMs: [80, 70, 60, 100, 90], // active, siblings, gds, commitments, stacked
    commitmentEvalMs: 15,
    rpcMs: 220,
  };
  const off = measureAcceptDeclineB3Workload({ ...base, enabled: false });
  const on = measureAcceptDeclineB3Workload({ ...base, enabled: true });
  assert(on.primaryPathMs < off.primaryPathMs, "ON must be faster on identical stages");
  assertEquals(on.eligibilityOfferMs, Math.max(180, 120));
  assertEquals(off.eligibilityOfferMs, 180 + 120);
  assert(on.savedMs > 0);
  // Authoritative RPC unchanged
  assertEquals(
    on.primaryPathMs - on.eligibilityOfferMs - on.preRpcBlockMs - 90,
    220,
  );
});

Deno.test("B3 never models skipping RPC or hold", () => {
  const m = measureAcceptDeclineB3Workload({
    enabled: true,
    eligibilityMs: 1,
    offerLookupMs: 1,
    holdOrMarketplaceMs: 50,
    preRpcParallelMembersMs: [1],
    commitmentEvalMs: 1,
    rpcMs: 500,
  });
  assert(m.primaryPathMs >= 500 + 50);
});
