/**
 * Lock: terminal lifecycle money/counter paths must claim via CAS predicates.
 * Soft read-then-return idempotency alone is not enough under concurrent Completes.
 *
 * Run: deno test --allow-read supabase/functions/_shared/tripLifecycleConditionalWrite.lock.test.ts
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  arrivePickupClaimPredicates,
  claimTripLifecycleWrite,
  completeTripClaimPredicates,
  startTripClaimPredicates,
  type TripWriteClient,
} from "./tripLifecycleConditionalWrite.ts";

function makeClient(opts: {
  data: { id?: string } | null;
  error?: { message: string; code?: string } | null;
  onFilter?: (filters: Array<{ op: string; column: string; value: unknown }>) => void;
}): TripWriteClient {
  const filters: Array<{ op: string; column: string; value: unknown }> = [];
  const builder = {
    eq(column: string, value: unknown) {
      filters.push({ op: "eq", column, value });
      return builder;
    },
    neq(column: string, value: unknown) {
      filters.push({ op: "neq", column, value });
      return builder;
    },
    is(column: string, value: null) {
      filters.push({ op: "is", column, value });
      return builder;
    },
    in(column: string, values: string[]) {
      filters.push({ op: "in", column, value: values });
      return builder;
    },
    select(_columns: string) {
      return {
        maybeSingle: async () => {
          opts.onFilter?.(filters);
          return { data: opts.data, error: opts.error ?? null };
        },
      };
    },
  };
  return {
    from(table: string) {
      assertEquals(table, "trips");
      return {
        update(_payload: Record<string, unknown>) {
          return builder;
        },
      };
    },
  };
}

Deno.test("completeTripClaimPredicates require not-completed + completed_at null", () => {
  assertEquals(completeTripClaimPredicates(), {
    statusNeq: "completed",
    completedAtIsNull: true,
  });
});

Deno.test("arrivePickupClaimPredicates require null arrived/started/completed stamps", () => {
  assertEquals(arrivePickupClaimPredicates(), {
    arrivedAtIsNull: true,
    startedAtIsNull: true,
    completedAtIsNull: true,
  });
});

Deno.test("startTripClaimPredicates require null started/completed stamps", () => {
  assertEquals(startTripClaimPredicates(), {
    startedAtIsNull: true,
    completedAtIsNull: true,
  });
});

Deno.test("claimTripLifecycleWrite returns claimed=true when a row matches", async () => {
  const filters: Array<{ op: string; column: string; value: unknown }> = [];
  const client = makeClient({
    data: { id: "trip-1" },
    onFilter: (f) => filters.push(...f),
  });
  const result = await claimTripLifecycleWrite(
    client,
    "trip-1",
    { status: "completed", completed_at: "2026-09-15T00:00:00Z" },
    completeTripClaimPredicates(),
  );
  assertEquals(result, { ok: true, claimed: true, id: "trip-1" });
  assertEquals(filters.some((f) => f.op === "eq" && f.column === "id" && f.value === "trip-1"), true);
  assertEquals(filters.some((f) => f.op === "neq" && f.column === "status" && f.value === "completed"), true);
  assertEquals(filters.some((f) => f.op === "is" && f.column === "completed_at" && f.value === null), true);
});

Deno.test("claimTripLifecycleWrite returns claimed=false on lost race (zero rows)", async () => {
  const client = makeClient({ data: null });
  const result = await claimTripLifecycleWrite(
    client,
    "trip-1",
    { status: "completed" },
    completeTripClaimPredicates(),
  );
  assertEquals(result, { ok: true, claimed: false });
});

Deno.test("claimTripLifecycleWrite surfaces provider errors fail-closed", async () => {
  const client = makeClient({
    data: null,
    error: { message: "db down", code: "57014" },
  });
  const result = await claimTripLifecycleWrite(
    client,
    "trip-1",
    { status: "in_progress" },
    startTripClaimPredicates(),
  );
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.message, "db down");
  }
});

Deno.test("stop-workflow complete_trip claims before settlement and total_trips", async () => {
  const src = await Deno.readTextFile(
    new URL("../stop-workflow/index.ts", import.meta.url),
  );
  assertEquals(src.includes('from "./tripLifecycleConditionalWrite.ts"'), true);
  assertEquals(src.includes("claimTripLifecycleWrite"), true);
  assertEquals(src.includes("claimStopLifecycleWrite"), true);
  assertEquals(src.includes("completeTripClaimPredicates"), true);
  assertEquals(src.includes("arrivePickupClaimPredicates"), true);
  assertEquals(src.includes("startTripClaimPredicates"), true);
  // Completion must gate money/counters on claim win
  assertEquals(src.includes("completionClaim"), true);
  assertEquals(src.includes("claimed: false"), true);
  assertEquals(src.includes("Trip already completed"), true);
  // Must not leave bare .eq("id", trip_id) as the only complete-status filter in the claim path
  assertEquals(src.includes("completeTripClaimPredicates()"), true);
  // total_trips increment only after claim
  const claimIdx = src.indexOf("completionClaim");
  const tripsIdx = src.indexOf("total_trips: currentTotalTrips + 1");
  assertEquals(claimIdx > 0 && tripsIdx > claimIdx, true);
});

Deno.test("stop-workflow arrive_stop and drive_to_next use stop-row CAS claims", async () => {
  const src = await Deno.readTextFile(
    new URL("../stop-workflow/index.ts", import.meta.url),
  );
  assertEquals(src.includes("arriveStopClaim"), true);
  assertEquals(src.includes("driveNextClaim"), true);
  assertEquals(src.includes("claimStopLifecycleWrite"), true);
});

Deno.test("tripLifecycle soft idempotent allows already-completed complete_trip", async () => {
  const { validateTripActionTransition } = await import("./tripLifecycle.ts");
  const result = validateTripActionTransition(
    "complete_trip",
    { status: "completed", completed_at: "2026-09-15T00:00:00Z", started_at: "2026-09-15T00:00:00Z" },
    [],
  );
  assertEquals(result.allowed, true);
  assertEquals(result.idempotent, true);
});

Deno.test("tripLifecycle soft idempotent allows already-started start_trip", async () => {
  const { validateTripActionTransition } = await import("./tripLifecycle.ts");
  const result = validateTripActionTransition(
    "start_trip",
    {
      status: "in_progress",
      started_at: "2026-09-15T00:00:00Z",
      arrived_at: "2026-09-15T00:00:00Z",
    },
    [],
  );
  assertEquals(result.allowed, true);
  assertEquals(result.idempotent, true);
});
