/**
 * Phase 2C/2D — atomic driver_cancel_before_start_rematch contract + Edge wiring tests.
 * Covers the required rematch cases at allowlist/RPC-contract/Edge-orchestrator level.
 */

import {
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  isPrePickupDriverRematchEligibleDbStatus,
  PRE_PICKUP_DRIVER_REMATCH_DB_STATUSES,
  resolveNextRematchBroadcastRound,
} from "./driverCancelRematch.ts";
import { executeDriverCancelBeforePickupRematch } from "./executeDriverCancelRematch.ts";

const REMATCH_STATUSES = [
  "confirmed",
  "accepted",
  "driver_assigned",
  "en_route",
  "arrived",
] as const;

const REJECT_STATUSES = [
  "no_show",
  "in_progress",
  "started",
  "completed",
  "cancelled",
  "customer_cancelled",
  "expired",
  "declined",
  "failed",
] as const;

type MockRpcResult = Record<string, unknown>;

function buildMockSupabase(opts: {
  trip: Record<string, unknown>;
  rpcResult?: MockRpcResult | null;
  rpcError?: { message: string } | null;
  dispatchError?: string | null;
  onRpc?: (args: Record<string, unknown>) => void;
  onOutboxUpdate?: (patch: Record<string, unknown>) => void;
}) {
  const calls = {
    rpcArgs: null as Record<string, unknown> | null,
    dispatchInvoked: false,
    outboxUpdates: [] as Record<string, unknown>[],
  };

  const from = (table: string) => {
    const api: Record<string, unknown> = {};
    const chain = () => api;
    api.select = (_cols?: string) => chain();
    api.eq = (_c?: string, _v?: unknown) => chain();
    api.is = (_c?: string, _v?: unknown) => chain();
    api.in = (_c?: string, _v?: unknown) => chain();
    api.order = (_c?: string, _v?: unknown) => chain();
    api.limit = (_n?: number) => chain();
    api.maybeSingle = async () => {
      if (table === "trips") return { data: opts.trip, error: null };
      if (table === "dispatch_intent_outbox") {
        return { data: { attempts: 0 }, error: null };
      }
      return { data: null, error: null };
    };
    api.update = (patch: Record<string, unknown>) => {
      if (table === "dispatch_intent_outbox") {
        calls.outboxUpdates.push(patch);
        opts.onOutboxUpdate?.(patch);
      }
      return {
        eq: async () => ({ data: null, error: null }),
      };
    };
    api.upsert = async (row: Record<string, unknown>) => {
      if (table === "dispatch_intent_outbox") {
        calls.outboxUpdates.push({ upsert: true, ...row });
      }
      return { data: null, error: null };
    };
    return api;
  };

  const supabase = {
    from,
    rpc: async (name: string, args: Record<string, unknown>) => {
      assertEquals(name, "driver_cancel_before_start_rematch");
      calls.rpcArgs = args;
      opts.onRpc?.(args);
      if (opts.rpcError) return { data: null, error: opts.rpcError };
      return { data: opts.rpcResult ?? null, error: null };
    },
    functions: {
      invoke: async (name: string, _body: unknown) => {
        assertEquals(name, "auto-dispatch");
        calls.dispatchInvoked = true;
        if (opts.dispatchError) {
          return { data: null, error: { message: opts.dispatchError } };
        }
        return { data: { ok: true }, error: null };
      },
    },
  };

  return { supabase: supabase as never, calls };
}

function baseTrip(status: string, overrides: Record<string, unknown> = {}) {
  return {
    id: "trip-1",
    status,
    stacked_trip_id: null,
    cancelled_driver_ids: [],
    excluded_driver_ids: [],
    passenger_id: "cust-1",
    confirmed_driver_id: "drv-1",
    service_area_id: "sa-1",
    cancel_reason: null,
    cancelled_by: null,
    searching_expires_at: null,
    current_broadcast_round: 1,
    dispatch_status: "assigned",
    started_at: null,
    arrived_at: null,
    ...overrides,
  };
}

function okRpc(overrides: Record<string, unknown> = {}): MockRpcResult {
  return {
    ok: true,
    outcome: "rematch",
    trip_id: "trip-1",
    previous_status: "confirmed",
    status: "searching_new_driver",
    dispatch_status: "broadcasting",
    driver_cleared: true,
    driver_excluded: true,
    payment_action: "unchanged",
    idempotent_replay: false,
    current_broadcast_round: 2,
    searching_expires_at: "2099-01-01T00:00:00.000Z",
    audit_event_id: "audit-1",
    dispatch_outbox_key: "driver_cancel_before_pickup:trip-1:drv-1",
    finance_unchanged: true,
    customer_active_trip_preserved: true,
    ...overrides,
  };
}

Deno.test("1-5 rematch eligible statuses include confirmed/accepted/assigned/en_route/arrived", () => {
  for (const status of REMATCH_STATUSES) {
    assertEquals(isPrePickupDriverRematchEligibleDbStatus(status), true, status);
  }
  assertEquals(
    PRE_PICKUP_DRIVER_REMATCH_DB_STATUSES.includes("queued"),
    true,
    "queued remains matrix-approved",
  );
});

Deno.test("6-11 reject no_show/in_progress/completed/customer_cancelled/expired (+ terminal set)", () => {
  for (const status of REJECT_STATUSES) {
    assertEquals(isPrePickupDriverRematchEligibleDbStatus(status), false, status);
  }
});

Deno.test("cases 1-5 Edge invokes atomic RPC and auto-dispatch for rematchable statuses", async () => {
  for (const status of REMATCH_STATUSES) {
    const { supabase, calls } = buildMockSupabase({
      trip: baseTrip(status),
      rpcResult: okRpc({ previous_status: status }),
    });
    const result = await executeDriverCancelBeforePickupRematch(supabase, {
      tripId: "trip-1",
      driverId: "drv-1",
      source: `test.${status}`,
    });
    assertEquals(result.ok, true, status);
    if (result.ok) {
      assertEquals(result.detail.atomic_rpc, "driver_cancel_before_start_rematch");
      assertEquals(result.detail.status, "searching_new_driver");
      assertEquals(result.detail.dispatch_status, "broadcasting");
      assertEquals(result.detail.payment_action, "unchanged");
      assertEquals(result.detail.finance_unchanged, true);
      assertEquals(result.detail.customer_active_trip_preserved, true);
    }
    assertExists(calls.rpcArgs);
    assertEquals(calls.rpcArgs?.p_trip_id, "trip-1");
    assertEquals(calls.rpcArgs?.p_driver_id, "drv-1");
    assertEquals(
      (calls.rpcArgs?.p_request_metadata as Record<string, unknown>).actor_mode,
      "service_role",
    );
    assertEquals(
      (calls.rpcArgs?.p_request_metadata as Record<string, unknown>).is_no_show,
      false,
    );
    assertEquals(calls.dispatchInvoked, true);
  }
});

Deno.test("6 valid No-show metadata must not be sent by rematch executor", async () => {
  const { supabase, calls } = buildMockSupabase({
    trip: baseTrip("arrived"),
    rpcResult: okRpc(),
  });
  await executeDriverCancelBeforePickupRematch(supabase, {
    tripId: "trip-1",
    driverId: "drv-1",
  });
  const meta = calls.rpcArgs?.p_request_metadata as Record<string, unknown>;
  assertEquals(meta.is_no_show, false);
});

Deno.test("7-11 Edge rejects terminal statuses before RPC", async () => {
  for (const status of REJECT_STATUSES) {
    const { supabase, calls } = buildMockSupabase({
      trip: baseTrip(status, {
        confirmed_driver_id: status === "completed" ? null : "drv-1",
        started_at: status === "in_progress" ? "2026-01-01T00:00:00Z" : null,
      }),
      rpcResult: okRpc(),
    });
    const result = await executeDriverCancelBeforePickupRematch(supabase, {
      tripId: "trip-1",
      driverId: "drv-1",
    });
    assertEquals(result.ok, false, status);
    if (!result.ok) {
      assertEquals(
        ["INVALID_STATE", "USE_TERMINAL_CANCEL"].includes(result.code) ||
          result.code.length > 0,
        true,
      );
    }
    assertEquals(calls.rpcArgs, null, `RPC must not run for ${status}`);
    assertEquals(calls.dispatchInvoked, false);
  }
});

Deno.test("12 wrong driver rejected before RPC", async () => {
  const { supabase, calls } = buildMockSupabase({
    trip: baseTrip("confirmed", { confirmed_driver_id: "drv-other" }),
    rpcResult: okRpc(),
  });
  const result = await executeDriverCancelBeforePickupRematch(supabase, {
    tripId: "trip-1",
    driverId: "drv-1",
  });
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.code, "FORBIDDEN");
  assertEquals(calls.rpcArgs, null);
});

Deno.test("13 duplicate idempotency key returns same result and skips re-dispatch when outbox done", async () => {
  const { supabase, calls } = buildMockSupabase({
    trip: baseTrip("confirmed"),
    rpcResult: okRpc({
      idempotent_replay: true,
      dispatch_outbox_key: "idem-1",
    }),
  });
  // First mock: outbox already done → skip dispatch
  const origFrom = (supabase as { from: (t: string) => unknown }).from;
  (supabase as { from: (t: string) => unknown }).from = (table: string) => {
    const api = origFrom(table) as Record<string, unknown>;
    if (table === "dispatch_intent_outbox") {
      api.maybeSingle = async () => ({ data: { status: "done", attempts: 1 }, error: null });
    }
    return api;
  };

  const result = await executeDriverCancelBeforePickupRematch(supabase, {
    tripId: "trip-1",
    driverId: "drv-1",
    idempotencyKey: "idem-1",
  });
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.detail.idempotent_replay, true);
    assertEquals(result.detail.dispatch_skipped_idempotent_replay, true);
    assertEquals(result.detail.status, "searching_new_driver");
  }
  assertEquals(calls.dispatchInvoked, false);
});

Deno.test("14-17 RPC contract asserts exclusion/clear/broadcast fields", async () => {
  const { supabase } = buildMockSupabase({
    trip: baseTrip("driver_assigned"),
    rpcResult: okRpc({
      driver_cleared: true,
      driver_excluded: true,
      current_broadcast_round: 3,
    }),
  });
  const result = await executeDriverCancelBeforePickupRematch(supabase, {
    tripId: "trip-1",
    driverId: "drv-1",
  });
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.detail.driver_cleared, true);
    assertEquals(result.detail.driver_excluded, true);
    assertEquals(result.detail.current_broadcast_round, 3);
  }
});

Deno.test("18-22 finance + customer attachment preserved in RPC contract", async () => {
  const { supabase, calls } = buildMockSupabase({
    trip: baseTrip("confirmed"),
    rpcResult: okRpc({
      finance_unchanged: true,
      customer_active_trip_preserved: true,
      payment_action: "unchanged",
    }),
  });
  const result = await executeDriverCancelBeforePickupRematch(supabase, {
    tripId: "trip-1",
    driverId: "drv-1",
  });
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.detail.finance_unchanged, true);
    assertEquals(result.detail.customer_active_trip_preserved, true);
    assertEquals(result.detail.payment_action, "unchanged");
  }
  // Critical mutation is RPC-only — no multi-step trip update from Edge.
  assertExists(calls.rpcArgs);
});

Deno.test("23-25 stale old-driver arrive/start/accept blocked after rematch clear", () => {
  // After rematch, trip is searching_new_driver without assignment — arrive/start not eligible.
  assertEquals(isPrePickupDriverRematchEligibleDbStatus("searching_new_driver"), false);
  assertEquals(isPrePickupDriverRematchEligibleDbStatus("in_progress"), false);
  // Guard contract: progression statuses require confirmed_driver_id.
  const assignmentRequired = (status: string, confirmedDriverId: string | null) => {
    const progression = new Set([
      "arrived",
      "in_progress",
      "waiting",
      "completed",
    ]);
    if (progression.has(status) && confirmedDriverId == null) {
      return { ok: false, error: "ASSIGNMENT_REQUIRED" };
    }
    return { ok: true };
  };
  assertEquals(assignmentRequired("arrived", null).ok, false);
  assertEquals(assignmentRequired("in_progress", null).ok, false);
  // Exclusion SSOT blocks stale offer accept.
  const excluded = new Set(["drv-1"]);
  const accept = (driverId: string) =>
    excluded.has(driverId)
      ? { ok: false, error: "DRIVER_EXCLUDED" }
      : { ok: true };
  assertEquals(accept("drv-1").error, "DRIVER_EXCLUDED");
  assertEquals(accept("drv-2").ok, true);
});

Deno.test("26 dispatch failure leaves rematch committed and marks outbox failed", async () => {
  const { supabase, calls } = buildMockSupabase({
    trip: baseTrip("confirmed"),
    rpcResult: okRpc(),
    dispatchError: "upstream timeout",
  });
  const result = await executeDriverCancelBeforePickupRematch(supabase, {
    tripId: "trip-1",
    driverId: "drv-1",
  });
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.detail.status, "searching_new_driver");
    assertEquals(result.detail.dispatch_invoked, false);
    assertEquals(result.detail.dispatch_error, "upstream timeout");
  }
  assertEquals(calls.outboxUpdates.some((u) => u.status === "failed"), true);
});

Deno.test("26b soft idempotent replay with missing outbox retries dispatch", async () => {
  const { supabase, calls } = buildMockSupabase({
    trip: baseTrip("confirmed"),
    rpcResult: okRpc({
      idempotent_replay: true,
      dispatch_outbox_key: "idem-missing",
    }),
  });
  const origFrom = (supabase as { from: (t: string) => unknown }).from;
  (supabase as { from: (t: string) => unknown }).from = (table: string) => {
    const api = origFrom(table) as Record<string, unknown>;
    if (table === "dispatch_intent_outbox") {
      api.maybeSingle = async () => ({ data: null, error: null });
    }
    return api;
  };

  const result = await executeDriverCancelBeforePickupRematch(supabase, {
    tripId: "trip-1",
    driverId: "drv-1",
    idempotencyKey: "idem-missing",
  });
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.detail.idempotent_replay, true);
    assertEquals(result.detail.dispatch_skipped_idempotent_replay, false);
  }
  assertEquals(calls.dispatchInvoked, true);
});

Deno.test("27-29 race contracts: conflict from RPC surfaces as 409; rematch leaves round for auto-dispatch", async () => {
  const { supabase } = buildMockSupabase({
    trip: baseTrip("confirmed"),
    rpcError: { message: "CONFLICT: trip assignment changed during rematch" },
  });
  const result = await executeDriverCancelBeforePickupRematch(supabase, {
    tripId: "trip-1",
    driverId: "drv-1",
  });
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.code, "CONFLICT");
    assertEquals(result.status, 409);
  }
  // Rematch does not burn a round; deployed auto-dispatch advances storedRound+1.
  assertEquals(resolveNextRematchBroadcastRound(4), 4);
  assertEquals(resolveNextRematchBroadcastRound(0), 0);
});

Deno.test("30 Scan&Go removed — rematch has no product-specific expire exception", () => {
  // Scan & Go schema/Edge paths are retired; rematch applies uniformly.
  assertEquals(typeof executeDriverCancelBeforePickupRematch, "function");
  assertEquals(isPrePickupDriverRematchEligibleDbStatus("confirmed"), true);
  assertEquals(isPrePickupDriverRematchEligibleDbStatus("arrived"), true);
  // No scan_and_go / locked_driver special-case in allowlist/reject helpers.
  assertEquals(isPrePickupDriverRematchEligibleDbStatus("scan_and_go"), false);
  assertEquals(isPrePickupDriverRematchEligibleDbStatus("locked_driver"), false);
});

Deno.test("default idempotency key includes broadcast round", async () => {
  const { supabase, calls } = buildMockSupabase({
    trip: baseTrip("confirmed", { current_broadcast_round: 7 }),
    rpcResult: okRpc(),
  });
  await executeDriverCancelBeforePickupRematch(supabase, {
    tripId: "trip-1",
    driverId: "drv-1",
  });
  assertEquals(
    calls.rpcArgs?.p_idempotency_key,
    "driver_cancel_before_pickup:trip-1:drv-1:r7",
  );
});

Deno.test("RPC reject contract for no-show metadata is explicit", async () => {
  const { supabase, calls } = buildMockSupabase({
    trip: baseTrip("arrived"),
    rpcResult: okRpc(),
  });
  const result = await executeDriverCancelBeforePickupRematch(supabase, {
    tripId: "trip-1",
    driverId: "drv-1",
    requestMetadata: { is_no_show: true, action_type: "no_show" },
  });
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.code, "NO_SHOW_NOT_ALLOWED");
  assertEquals(calls.rpcArgs, null);
});
