import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  applyCanonicalSettlementAfterCapture,
  recoveryWalletCreditFromSavedStamps,
} from "./applyCanonicalSettlementAfterCapture.ts";

const MK_TRIP = {
  id: "trip-mk-005",
  trip_code: "MK-260817-005",
  driver_id: "driver-1",
  currency_code: "GBP",
  fare_snapshot_json: { gross_fare_pence: 500 },
  locked_base_fare_pence: 500,
  offer_discount_pence: 50,
  discount_source: "global_offer",
  customer_modification_charge_pence: 249,
  accepted_commission_percent: 15,
  capture_amount_pence: 699,
  driver_net_pence: 637,
  payment_status: "captured",
  created_at: "2026-08-17T09:00:00.000Z",
};

const CONFIRMED_PS = {
  status: "captured",
  provider_state: "COMPLETED",
  captured_amount_pence: 699,
  provider_state_verified_at: "2026-08-17T10:00:00.000Z",
  purpose: "TRIP",
};

type OpLog = { table: string; op: string; payload: Record<string, unknown> };
type Scenario = "success" | "insert_fail" | "already_posted" | "ps_missing" | "ps_unverified";

function mockSupabase(scenario: Scenario) {
  const ops: OpLog[] = [];
  let ledgerRows: Array<Record<string, unknown>> = scenario === "already_posted"
    ? [{ related_trip_id: "trip-mk-005", type: "TRIP_EARNING_NET", amount_pence: 637 }]
    : [];
  const mismatches: Array<Record<string, unknown>> = [];

  const client = {
    from(table: string) {
      const state: { filters: Record<string, unknown> } = { filters: {} };
      const chain = {
        select() { return chain; },
        eq(col: string, val: unknown) {
          state.filters[col] = val;
          return chain;
        },
        neq() { return chain; },
        order() { return chain; },
        limit() { return chain; },
        maybeSingle: async () => {
          if (table === "payment_sessions") {
            if (scenario === "ps_missing") return { data: null, error: null };
            if (scenario === "ps_unverified") {
              return {
                data: { ...CONFIRMED_PS, provider_state_verified_at: null },
                error: null,
              };
            }
            return { data: CONFIRMED_PS, error: null };
          }
          if (table === "driver_wallet_ledger" && state.filters.type === "TRIP_EARNING_NET") {
            const hit = ledgerRows.find((r) =>
              r.related_trip_id === state.filters.related_trip_id && r.type === "TRIP_EARNING_NET");
            return { data: hit ? { id: "existing", amount_pence: hit.amount_pence } : null, error: null };
          }
          return { data: null, error: null };
        },
        then(onFulfilled: (v: { data: unknown; error: null }) => unknown) {
          const rows = table === "driver_wallet_ledger"
            ? ledgerRows.filter((r) =>
              r.related_trip_id === state.filters.related_trip_id
              && (state.filters.type == null || r.type === state.filters.type)
            )
            : [];
          return Promise.resolve({ data: rows, error: null }).then(onFulfilled);
        },
        insert: (payload: Record<string, unknown>) => {
          ops.push({ table, op: "insert", payload });
          if (table === "financial_ssot_mismatches") {
            mismatches.push(payload);
            return Promise.resolve({ error: null });
          }
          if (table === "driver_wallet_ledger") {
            if (scenario === "insert_fail") {
              return Promise.resolve({
                error: { message: "permission denied for table driver_wallet_ledger", code: "42501" },
              });
            }
            ledgerRows.push(payload);
          }
          return Promise.resolve({ error: null });
        },
        update: (payload: Record<string, unknown>) => {
          ops.push({ table, op: "update", payload });
          return chain;
        },
        upsert: (payload: Record<string, unknown>) => {
          ops.push({ table, op: "upsert", payload });
          mismatches.push(payload);
          return Promise.resolve({ error: null });
        },
      };
      return chain;
    },
  };

  return { client, ops, getLedgerRows: () => ledgerRows, getMismatches: () => mismatches };
}

Deno.test("4 — capture posts one 637p TRIP_EARNING_NET; retry does not duplicate", async () => {
  const { client, ops, getLedgerRows } = mockSupabase("success");
  await applyCanonicalSettlementAfterCapture({
    supabase: client as never,
    tripId: "trip-mk-005",
    trip: MK_TRIP,
    captureAmountPence: 699,
    mode: "fresh_capture",
  });
  const inserts = ops.filter((o) => o.table === "driver_wallet_ledger" && o.op === "insert");
  assertEquals(inserts.length, 1);
  assertEquals(inserts[0].payload.amount_pence, 637);
  assertEquals(inserts[0].payload.type, "TRIP_EARNING_NET");

  const second = mockSupabase("already_posted");
  await applyCanonicalSettlementAfterCapture({
    supabase: second.client as never,
    tripId: "trip-mk-005",
    trip: MK_TRIP,
    captureAmountPence: 699,
    mode: "fresh_capture",
  });
  const secondInserts = second.ops.filter((o) => o.table === "driver_wallet_ledger" && o.op === "insert");
  assertEquals(secondInserts.length, 0);
  assertEquals(getLedgerRows().length, 1);
});

Deno.test("5 — wallet insert failure upserts WALLET_MISMATCH breadcrumb; does not recapture", async () => {
  const { client, getMismatches, ops } = mockSupabase("insert_fail");
  let thrown = false;
  try {
    await applyCanonicalSettlementAfterCapture({
      supabase: client as never,
      tripId: "trip-mk-005",
      trip: MK_TRIP,
      captureAmountPence: 699,
      mode: "fresh_capture",
    });
  } catch {
    thrown = true;
  }
  assertEquals(thrown, true);
  const mismatch = getMismatches().find((m) => m.field_name === "WALLET_MISMATCH");
  assertEquals(mismatch?.field_name, "WALLET_MISMATCH");
  assertEquals(mismatch?.expected_pence, 637);
  assertEquals(mismatch?.actual_pence, 0);
  assertEquals((mismatch?.details as { status?: string })?.status, "WALLET_MISMATCH");
  assertEquals(Boolean((mismatch?.details as { error?: string })?.error), true);
  assertEquals(ops.some((o) => o.table === "payments"), false);
  assertEquals(ops.filter((o) => o.table === "driver_wallet_ledger" && o.op === "insert").length, 1);
});

Deno.test("6 — historical recovery is detect-only: no ledger insert", async () => {
  const { client, ops } = mockSupabase("success");
  await applyCanonicalSettlementAfterCapture({
    supabase: client as never,
    tripId: "trip-mk-005",
    trip: MK_TRIP,
    captureAmountPence: 699,
    mode: "recovery",
  });
  assertEquals(ops.some((o) => o.table === "driver_wallet_ledger" && o.op === "insert"), false);
  assertEquals(ops.some((o) => o.table === "trips" && o.op === "update"), false);
});

Deno.test("recovery posts persisted 637p, not a recalculated double-count", async () => {
  const { client, ops } = mockSupabase("success");
  await applyCanonicalSettlementAfterCapture({
    supabase: client as never,
    tripId: "trip-mk-005",
    trip: {
      ...MK_TRIP,
      gross_fare_pence: 749,
      customer_modification_charge_pence: 249,
      driver_net_pence: 637,
      created_at: "2026-08-17T09:00:00.000Z",
    },
    captureAmountPence: 699,
    mode: "recovery",
    activatedAtMs: Date.parse("2026-08-01T00:00:00.000Z"),
  });
  const inserts = ops.filter((o) => o.table === "driver_wallet_ledger" && o.op === "insert");
  assertEquals(inserts.length, 1);
  assertEquals(inserts[0].payload.amount_pence, 637);
  assertEquals(ops.some((o) => o.table === "trips" && o.op === "update"), false);
});

Deno.test("recovery saved-stamp helper never uses fare/promotion fields", () => {
  const saved = recoveryWalletCreditFromSavedStamps({
    driver_net_pence: 637,
    airport_charge_pence: 0,
    fare_snapshot_json: { gross_fare_pence: 500 },
    gross_fare_pence: 749,
    customer_modification_charge_pence: 249,
    offer_discount_pence: 50,
    capture_amount_pence: 699,
  });
  assertEquals(saved.expectedCredit, 637);
});

Deno.test("unset activation does not block fresh_capture wallet posting", async () => {
  const { client, ops } = mockSupabase("success");
  await applyCanonicalSettlementAfterCapture({
    supabase: client as never,
    tripId: "trip-mk-005",
    trip: MK_TRIP,
    captureAmountPence: 699,
    mode: "fresh_capture",
    activatedAtMs: null,
  });
  const inserts = ops.filter((o) => o.table === "driver_wallet_ledger" && o.op === "insert");
  assertEquals(inserts.length, 1);
  assertEquals(inserts[0].payload.amount_pence, 637);
});

Deno.test("Payment Sessions missing or unverified: no wallet insert even if trip.payment_status=captured", async () => {
  for (const scenario of ["ps_missing", "ps_unverified"] as const) {
    const { client, ops } = mockSupabase(scenario);
    await applyCanonicalSettlementAfterCapture({
      supabase: client as never,
      tripId: "trip-mk-005",
      trip: { ...MK_TRIP, payment_status: "captured" },
      captureAmountPence: 699,
      mode: "fresh_capture",
    });
    assertEquals(ops.some((o) => o.table === "driver_wallet_ledger" && o.op === "insert"), false);
    assertEquals(ops.some((o) => o.table === "payments"), false);
  }
});
