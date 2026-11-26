/**
 * P6 — complete_trip non-atomic hardening (atomic RPC remains STOP).
 *  1. Authoritative completion UPDATE is conditional (not already completed, completed_at null)
 *     so concurrent Completes cannot re-stamp tip_window_expires_at.
 *  2. Idempotent completed branch heals a missing PENDING (only: PLATFORM_COLLECTED,
 *     driver_net_pence > 0, awaiting capture, no TEN yet).
 *  3. Never invents PENDING when TEN exists / trip settled.
 *  4. complete_trip_atomic is still NOT called.
 * If these fail, fix the code — never delete or soften the lock.
 */
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type IdempotentPendingRecoveryDeps,
  recoverMissingPendingOnIdempotentComplete,
} from "../../functions/stop-workflow/lib/idempotentCompletePendingRecovery.ts";

const read = (rel: string) => Deno.readTextFile(new URL(rel, import.meta.url));
const src = await read("../../functions/stop-workflow/index.ts");
const helperSrc = await read("../../functions/stop-workflow/lib/idempotentCompletePendingRecovery.ts");

const completeCase = src.slice(src.indexOf("case 'complete_trip': {"));

Deno.test("completion UPDATE is conditional on not-completed + completed_at null", () => {
  const at = completeCase.indexOf("completed_at: now,");
  assert(at > 0);
  const tail = completeCase.slice(at, at + 3000);
  assert(tail.includes('.neq("status", "completed")'));
  assert(tail.includes('.is("completed_at", null)'));
  // Conditional filters sit before .select(...).maybeSingle() of the same write.
  assert(tail.indexOf('.neq("status", "completed")') < tail.indexOf(".maybeSingle()"));
});

Deno.test("lost-race completion returns idempotent success, not a second stamp", () => {
  assertStringIncludes(completeCase, "idempotent_race_completed");
  assertStringIncludes(completeCase, "recoverMissingPendingOnIdempotentComplete(supabase, trip_id)");
});

Deno.test("idempotent completed branch invokes bounded PENDING recovery", () => {
  const idem = completeCase.slice(
    completeCase.indexOf("// Idempotency: already completed"),
    completeCase.indexOf("Payment gate is advisory"),
  );
  assertStringIncludes(idem, "recoverMissingPendingOnIdempotentComplete(supabase, trip_id)");
  assertStringIncludes(idem, "idempotent: true");
});

Deno.test("complete_trip_atomic is still not called (atomic remains STOP)", () => {
  assertEquals(/rpc\(\s*["']complete_trip_atomic/.test(src), false);
  assertEquals(/rpc\(\s*["']complete_trip_atomic/.test(helperSrc), false);
});

type Trip = Record<string, unknown>;
function fakeSupabase(trip: Trip | null, pending: boolean) {
  return {
    from(table: string) {
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: () =>
          Promise.resolve(
            table === "trips" ? { data: trip, error: null } : { data: pending ? { id: "p1" } : null, error: null },
          ),
      };
      return chain;
    },
  };
}
function deps(tenCount: number) {
  const calls: unknown[] = [];
  const d: IdempotentPendingRecoveryDeps = {
    readTen: () => Promise.resolve({ count: tenCount }),
    creditPending: ((_s: unknown, args: unknown) => {
      calls.push(args);
      return Promise.resolve({ ok: true, inserted: true, reason: "inserted" });
    }) as IdempotentPendingRecoveryDeps["creditPending"],
  };
  return { d, calls };
}
const base: Trip = {
  id: "t1",
  status: "completed",
  driver_id: "d1",
  financial_model: "PLATFORM_COLLECTED",
  payment_status: "capture_requested",
  driver_net_pence: 800,
  airport_charge_pence: 0,
};

Deno.test("recovery inserts PENDING when eligible, missing, no TEN", async () => {
  const { d, calls } = deps(0);
  const r = await recoverMissingPendingOnIdempotentComplete(fakeSupabase(base, false), "t1", d);
  assertEquals(r.outcome, "inserted");
  assertEquals(calls.length, 1);
  assertEquals((calls[0] as { amountPence: number }).amountPence, 800);
});

Deno.test("recovery NEVER invents PENDING when TEN exists", async () => {
  const { d, calls } = deps(1);
  const r = await recoverMissingPendingOnIdempotentComplete(fakeSupabase(base, false), "t1", d);
  assertEquals(r.outcome, "ten_exists");
  assertEquals(calls.length, 0);
});

Deno.test("recovery skips settled / captured trips (no historical PENDING)", async () => {
  for (const pay of ["captured", "paid", "succeeded", "refunded", "capture_failed"]) {
    const { d, calls } = deps(0);
    const r = await recoverMissingPendingOnIdempotentComplete(
      fakeSupabase({ ...base, payment_status: pay }, false),
      "t1",
      d,
    );
    assertEquals(r.outcome, "not_eligible", pay);
    assertEquals(calls.length, 0);
  }
});

Deno.test("recovery skips non-positive net, wrong model, existing PENDING", async () => {
  const cases: Array<[Trip, boolean, string]> = [
    [{ ...base, driver_net_pence: 0 }, false, "no_entitlement"],
    [{ ...base, financial_model: "DRIVER_COLLECTED_COMMISSION_WALLET" }, false, "not_eligible"],
    [base, true, "already_present"],
    [{ ...base, status: "in_progress" }, false, "not_eligible"],
  ];
  for (const [trip, pending, want] of cases) {
    const { d, calls } = deps(0);
    const r = await recoverMissingPendingOnIdempotentComplete(fakeSupabase(trip, pending), "t1", d);
    assertEquals(r.outcome, want);
    assertEquals(calls.length, 0);
  }
});

Deno.test("recovery never throws (Driver must not be stuck on Complete)", async () => {
  const { d } = deps(0);
  d.readTen = () => Promise.reject(new Error("boom"));
  const r = await recoverMissingPendingOnIdempotentComplete(fakeSupabase(base, false), "t1", d);
  assertEquals(r.outcome, "failed");
});
