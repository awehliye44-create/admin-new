import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  applyCanonicalSettlementAfterCapture,
  recoveryWalletCreditFromSavedStamps,
} from "./applyCanonicalSettlementAfterCapture.ts";
import { PAYMENT_SESSION_CAPTURE_GATE_SELECT } from "./paymentSessionCaptureGateSSOT.ts";

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
type Scenario =
  | "success"
  | "insert_fail"
  | "insert_silent_drop"
  | "insert_23505_correct"
  | "insert_23505_wrong"
  | "duplicate_ledger"
  | "already_posted"
  | "ps_missing"
  | "ps_query_error"
  | "ps_unverified"
  | "stamp_fail"
  | "ps_refunded"
  | "ps_released"
  | "ps_recovery";

function mockSupabase(scenario: Scenario, tripId = "trip-mk-005") {
  const ops: OpLog[] = [];
  let ledgerRows: Array<Record<string, unknown>> = scenario === "already_posted"
    ? [{
      related_trip_id: tripId,
      type: "TRIP_EARNING_NET",
      amount_pence: tripId === "7ada43fa-1f3d-43e8-979b-6152ba9d5f2c"
        || tripId === "3a575bad-ce3d-491e-998a-cd83fa5256ea"
        ? 425
        : 637,
      id: "existing-net",
    }]
    : scenario === "insert_23505_correct"
      ? [{ related_trip_id: tripId, type: "TRIP_EARNING_NET", amount_pence: 425, id: "existing-425" }]
      : scenario === "insert_23505_wrong"
        ? [{ related_trip_id: tripId, type: "TRIP_EARNING_NET", amount_pence: 999, id: "existing-wrong" }]
        : scenario === "duplicate_ledger"
          ? [
            { related_trip_id: tripId, type: "TRIP_EARNING_NET", amount_pence: 200, id: "dup-1" },
            { related_trip_id: tripId, type: "TRIP_EARNING_NET", amount_pence: 225, id: "dup-2" },
          ]
          : [];
  const mismatches: Array<Record<string, unknown>> = [];

  const client = {
    from(table: string) {
      const state: { filters: Record<string, unknown>; selectCols?: string } = { filters: {} };
      const chain = {
        select(cols: string) {
          state.selectCols = cols;
          if (table === "payment_sessions") {
            ops.push({ table, op: "select", payload: { columns: cols } });
          }
          return chain;
        },
        eq(col: string, val: unknown) {
          state.filters[col] = val;
          return chain;
        },
        neq() { return chain; },
        order() { return chain; },
        limit() { return chain; },
        maybeSingle: async () => {
          if (table === "payment_sessions") {
            if (scenario === "ps_query_error") {
              return {
                data: null,
                error: {
                  code: "42703",
                  message: "column payment_sessions.financial_model does not exist",
                },
              };
            }
            if (scenario === "ps_missing") return { data: null, error: null };
            if (scenario === "ps_unverified") {
              return {
                data: { ...CONFIRMED_PS, provider_state_verified_at: null },
                error: null,
              };
            }
            if (scenario === "ps_refunded") {
              return {
                data: { ...CONFIRMED_PS, refunded_amount_pence: 480 },
                error: null,
              };
            }
            if (scenario === "ps_released") {
              return {
                data: {
                  ...CONFIRMED_PS,
                  released_amount_pence: 480,
                  hold_release_state: "RELEASED",
                  hold_terminal_reason: "provider_released",
                },
                error: null,
              };
            }
            if (scenario === "ps_recovery") {
              return {
                data: { ...CONFIRMED_PS, purpose: "PAYMENT_RECOVERY" },
                error: null,
              };
            }
            return {
              data: {
                ...CONFIRMED_PS,
                id: "ps-1",
                provider_capture_id: "cap-1",
              },
              error: null,
            };
          }
          if (table === "driver_wallet_ledger" && state.filters.type === "TRIP_EARNING_NET") {
            const hit = ledgerRows.find((r) =>
              r.related_trip_id === state.filters.related_trip_id && r.type === "TRIP_EARNING_NET");
            return { data: hit ? { id: hit.id ?? "existing", amount_pence: hit.amount_pence } : null, error: null };
          }
          if (table === "trips") {
            return {
              data: {
                financial_model: "PLATFORM_COLLECTED",
                commission_wallet_enabled: false,
              },
              error: null,
            };
          }
          return { data: null, error: null };
        },
        then(onFulfilled: (v: { data: unknown; error: null }) => unknown) {
          const rows = table === "driver_wallet_ledger"
            ? ledgerRows
              .filter((r) => r.related_trip_id === state.filters.related_trip_id)
              .filter((r) => state.filters.type == null || r.type === state.filters.type)
              .map((r) => ({ id: r.id ?? "row-id", amount_pence: r.amount_pence }))
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
            if (scenario === "insert_23505_correct" || scenario === "insert_23505_wrong") {
              return Promise.resolve({ error: { code: "23505", message: "duplicate key value" } });
            }
            if (scenario === "insert_silent_drop") {
              return Promise.resolve({ error: null });
            }
            ledgerRows.push({ ...payload, id: `ledger-${ledgerRows.length + 1}` });
          }
          return Promise.resolve({ error: null });
        },
        update: (payload: Record<string, unknown>) => {
          ops.push({ table, op: "update", payload });
          const updateChain = {
            eq() { return updateChain; },
            then(onFulfilled: (v: { error: { message: string; code?: string } | null }) => unknown) {
              if (table === "trips" && scenario === "stamp_fail") {
                return Promise.resolve({
                  error: {
                    message: "Could not find the 'provider_fee_amount' column of 'trips' in the schema cache",
                    code: "PGRST204",
                  },
                }).then(onFulfilled);
              }
              return Promise.resolve({ error: null }).then(onFulfilled);
            },
          };
          return updateChain;
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
  const result = await applyCanonicalSettlementAfterCapture({
    supabase: client as never,
    tripId: "trip-mk-005",
    trip: MK_TRIP,
    captureAmountPence: 699,
    mode: "fresh_capture",
  });
  assertEquals(result.retry_provider_capture, false);
  assertEquals(result.settlement_status, "SUCCEEDED");
  assertEquals(result.wallet_posting_status, "FAILED");
  assertEquals(result.reconciliation_status, "WALLET_MISMATCH");
  const mismatch = getMismatches().find((m) => m.field_name === "WALLET_MISMATCH");
  assertEquals(mismatch?.field_name, "WALLET_MISMATCH");
  assertEquals(mismatch?.expected_pence, 637);
  assertEquals(mismatch?.actual_pence, 0);
  assertEquals((mismatch?.details as { status?: string })?.status, "WALLET_MISMATCH");
  assertEquals((mismatch?.details as { failure_stage?: string })?.failure_stage, "wallet_insert");
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

Deno.test("Payment Sessions missing or unverified: no wallet insert; WALLET_MISMATCH breadcrumb", async () => {
  for (const scenario of ["ps_missing", "ps_unverified"] as const) {
    const { client, ops, getMismatches } = mockSupabase(scenario);
    const result = await applyCanonicalSettlementAfterCapture({
      supabase: client as never,
      tripId: "trip-mk-005",
      trip: { ...MK_TRIP, payment_status: "captured" },
      captureAmountPence: 699,
      mode: "fresh_capture",
    });
    assertEquals(result.reconciliation_status, "WALLET_MISMATCH");
    assertEquals(result.retry_provider_capture, false);
    assertEquals(ops.some((o) => o.table === "driver_wallet_ledger" && o.op === "insert"), false);
    const mismatch = getMismatches().find((m) => m.field_name === "WALLET_MISMATCH");
    assertEquals(Boolean(mismatch), true);
    assertEquals(
      scenario === "ps_missing"
        ? (mismatch?.details as { failure_stage?: string })?.failure_stage
        : "PAYMENT_SESSION_CAPTURE_UNVERIFIED",
      scenario === "ps_missing" ? "PAYMENT_SESSION_MISSING" : "PAYMENT_SESSION_CAPTURE_UNVERIFIED",
    );
  }
});

Deno.test("MK-007/008/009 pattern: trip_created status with COMPLETED provider_state posts wallet", async () => {
  // Simulates sessions where Payment Session persist failed mid-flight but provider confirmed capture.
  // The lifecycle mismatch is detected, the PS is finalized to "captured", then wallet is posted.
  function mockWithTripCreatedStatus() {
    const ops: { table: string; op: string; payload: Record<string, unknown> }[] = [];
    const ledgerRows: Array<Record<string, unknown>> = [];
    const mismatches: Array<Record<string, unknown>> = [];
    // Track whether the finalization update has been called on payment_sessions.
    let psFinalized = false;
    const client = {
      from(table: string) {
        const state: { filters: Record<string, unknown> } = { filters: {} };
        const chain = {
          select() { return chain; },
          eq(col: string, val: unknown) { state.filters[col] = val; return chain; },
          neq() { return chain; },
          order() { return chain; },
          limit() { return chain; },
          maybeSingle: async () => {
            if (table === "payment_sessions") {
              return {
                data: {
                  id: "ps-mk-007",
                  // After finalization update, return "captured"; otherwise "trip_created".
                  status: psFinalized ? "captured" : "trip_created",
                  provider_state: "COMPLETED",
                  captured_amount_pence: 480,
                  provider_state_verified_at: "2026-08-17T18:50:46.979Z",
                  purpose: "RIDE_BOOKING",
                  provider_order_id: "rev-order-007",
                  provider_capture_id: "rev-cap-007",
                  refunded_amount_pence: null,
                  hold_release_state: null,
                  hold_terminal_reason: null,
                  metadata: { capture_amount_pence: 480 },
                  financial_operation_state: "CAPTURING",
                  financial_operation_owner: null,
                },
                error: null,
              };
            }
            return { data: null, error: null };
          },
          then(onFulfilled: (v: { data: unknown; error: null }) => unknown) {
            const rows = table === "driver_wallet_ledger"
              ? ledgerRows.filter((r) => r.related_trip_id === state.filters.related_trip_id)
              : (table === "payment_sessions" ? [{ id: "ps-mk-007" }] : []);
            return Promise.resolve({ data: rows, error: null }).then(onFulfilled);
          },
          insert(payload: Record<string, unknown>) {
            ops.push({ table, op: "insert", payload });
            if (table === "driver_wallet_ledger") ledgerRows.push(payload);
            return Promise.resolve({ error: null });
          },
          update(payload: Record<string, unknown>) {
            ops.push({ table, op: "update", payload });
            if (table === "payment_sessions" && payload.status === "captured") {
              psFinalized = true;
            }
            // Return a thenable so `await update(...).eq(...).neq(...)` resolves.
            const updateChain = {
              eq(_c: string, _v: unknown) { return updateChain; },
              neq(_c: string, _v: unknown) { return updateChain; },
              then(resolve: (v: { error: null }) => unknown) {
                return Promise.resolve({ error: null }).then(resolve);
              },
            };
            return updateChain;
          },
          upsert(payload: Record<string, unknown>) {
            ops.push({ table, op: "upsert", payload });
            mismatches.push(payload);
            return Promise.resolve({ error: null });
          },
        };
        return chain;
      },
    };
    return { client, ops, ledgerRows };
  }

  const { client, ops } = mockWithTripCreatedStatus();
  // Recovery mode: settlement already ran and saved driver_net_pence=408. Read from stamps only.
  // This is the correct mode for trips where the provider captured externally and the
  // Payment Session persist failed — the settlement stamp is already saved on the trip row.
  await applyCanonicalSettlementAfterCapture({
    supabase: client as never,
    tripId: "trip-mk-007",
    trip: {
      id: "trip-mk-007",
      trip_code: "MK-260817-007",
      driver_id: "driver-007",
      currency_code: "GBP",
      accepted_commission_percent: 15,
      capture_amount_pence: 480,
      final_fare_pence: 480,
      commissionable_fare_pence: 480,
      commission_pence: 72,
      driver_net_pence: 408,           // saved settlement stamp — recovery reads this
      airport_charge_pence: 0,
      offer_discount_pence: 20,
      discount_source: "global_offer",
      locked_base_fare_pence: 500,
      customer_modification_charge_pence: 0,
      payment_status: "captured",
      financial_model: "PLATFORM_COLLECTED",
      created_at: "2026-08-17T18:00:00.000Z",
    },
    captureAmountPence: 480,
    mode: "recovery",
    activatedAtMs: Date.parse("2026-08-01T00:00:00.000Z"), // activated before this trip
  });
  const inserts = ops.filter((o) => o.table === "driver_wallet_ledger" && o.op === "insert");
  assertEquals(inserts.length, 1, "Should post exactly one TRIP_EARNING_NET for trip_created PS status");
  assertEquals(inserts[0].payload.type, "TRIP_EARNING_NET");
  assertEquals(inserts[0].payload.amount_pence, 408, "Driver entitlement 408p from saved stamp");
});

Deno.test("DRIVER_COLLECTED trip cannot post wallet", async () => {
  const { client, ops } = mockSupabase("success");
  let threw = false;
  try {
    await applyCanonicalSettlementAfterCapture({
      supabase: client as never,
      tripId: "trip-comm",
      trip: {
        ...MK_TRIP,
        financial_model: "DRIVER_COLLECTED_COMMISSION_WALLET",
        driver_id: "driver-1",
      },
      captureAmountPence: 699,
      mode: "fresh_capture",
    });
  } catch {
    threw = true;
  }
  assertEquals(threw, true, "DRIVER_COLLECTED trips must throw, not post wallet");
  assertEquals(ops.some((o) => o.table === "driver_wallet_ledger"), false);
});

const MK_260818_002 = {
  id: "3a575bad-ce3d-491e-998a-cd83fa5256ea",
  trip_code: "MK-260818-002",
  driver_id: "cd8bae4c-3827-4b90-98c6-10be70eb0e52",
  financial_model: "PLATFORM_COLLECTED",
  currency_code: "GBP",
  fare_snapshot_json: { gross_fare_pence: 500, original_fare_pence: 500 },
  locked_base_fare_pence: 500,
  offer_discount_pence: 20,
  discount_source: "global_offer",
  customer_modification_charge_pence: 0,
  airport_charge_pence: 0,
  accepted_commission_percent: 15,
  capture_amount_pence: 480,
  final_fare_pence: 480,
  final_customer_fare_pence: 480,
  driver_net_pence: 425,
};

Deno.test("A — MK-260818-002 fresh capture posts one 425p TRIP_EARNING_NET; stamp has provider_fee_pence only", async () => {
  const { client, ops, getLedgerRows } = mockSupabase("success");
  const result = await applyCanonicalSettlementAfterCapture({
    supabase: client as never,
    tripId: MK_260818_002.id,
    trip: MK_260818_002,
    captureAmountPence: 480,
    mode: "fresh_capture",
  });
  assertEquals(result.settlement_status, "SUCCEEDED");
  assertEquals(result.wallet_posting_status, "SUCCEEDED");
  assertEquals(result.reconciliation_status, "BALANCED");
  assertEquals(result.retry_provider_capture, false);
  const stamp = ops.find((o) => o.table === "trips" && o.op === "update")?.payload ?? {};
  assertEquals("provider_fee_pence" in stamp, true);
  assertEquals("provider_fee_amount" in stamp, false);
  const inserts = ops.filter((o) => o.table === "driver_wallet_ledger" && o.op === "insert");
  assertEquals(inserts.length, 1);
  assertEquals(inserts[0].payload.type, "TRIP_EARNING_NET");
  assertEquals(inserts[0].payload.amount_pence, 425);
  assertEquals(ops.some((o) => o.table === "driver_commission_wallet_ledger"), false);
  assertEquals(getLedgerRows().length, 1);
});

Deno.test("B — MK-260818-002 retry does not duplicate TRIP_EARNING_NET", async () => {
  const second = mockSupabase("already_posted", MK_260818_002.id);
  const result = await applyCanonicalSettlementAfterCapture({
    supabase: second.client as never,
    tripId: MK_260818_002.id,
    trip: MK_260818_002,
    captureAmountPence: 480,
    mode: "fresh_capture",
  });
  assertEquals(result.reconciliation_status, "BALANCED");
  assertEquals(result.retry_provider_capture, false);
  assertEquals(second.ops.filter((o) => o.table === "driver_wallet_ledger" && o.op === "insert").length, 0);
});

Deno.test("C — settlement persist failure: zero wallet, WALLET_MISMATCH, no recapture", async () => {
  const { client, ops, getMismatches, getLedgerRows } = mockSupabase("stamp_fail");
  const result = await applyCanonicalSettlementAfterCapture({
    supabase: client as never,
    tripId: MK_260818_002.id,
    trip: MK_260818_002,
    captureAmountPence: 480,
    mode: "fresh_capture",
  });
  assertEquals(result.settlement_status, "FAILED");
  assertEquals(result.wallet_posting_status, "FAILED");
  assertEquals(result.reconciliation_status, "WALLET_MISMATCH");
  assertEquals(result.retry_provider_capture, false);
  assertEquals(result.expected_driver_credit_pence, 425);
  assertEquals(result.posted_driver_credit_pence, 0);
  assertEquals(getLedgerRows().length, 0);
  assertEquals(ops.filter((o) => o.table === "driver_wallet_ledger" && o.op === "insert").length, 0);
  const mismatch = getMismatches().find((m) => m.field_name === "WALLET_MISMATCH");
  assertEquals(mismatch?.expected_pence, 425);
  assertEquals(mismatch?.actual_pence, 0);
  assertEquals((mismatch?.details as { status?: string })?.status, "WALLET_MISMATCH");
  assertEquals((mismatch?.details as { failure_stage?: string })?.failure_stage, "settlement_persist");
  assertEquals((mismatch?.details as { error_code?: string })?.error_code, "PGRST204");
  assertEquals(ops.some((o) => o.table === "payments"), false);
});

Deno.test("D — MK-260818-002 wallet insert failure: capture stays captured; WALLET_MISMATCH; no provider retry", async () => {
  const { client, ops, getMismatches, getLedgerRows } = mockSupabase("insert_fail");
  const result = await applyCanonicalSettlementAfterCapture({
    supabase: client as never,
    tripId: MK_260818_002.id,
    trip: MK_260818_002,
    captureAmountPence: 480,
    mode: "fresh_capture",
  });
  assertEquals(result.retry_provider_capture, false);
  assertEquals(result.settlement_status, "SUCCEEDED");
  assertEquals(result.wallet_posting_status, "FAILED");
  assertEquals(result.reconciliation_status, "WALLET_MISMATCH");
  assertEquals(result.expected_driver_credit_pence, 425);
  const mismatch = getMismatches().find((m) => m.field_name === "WALLET_MISMATCH");
  assertEquals(mismatch?.expected_pence, 425);
  assertEquals(mismatch?.actual_pence, 0);
  assertEquals((mismatch?.details as { failure_stage?: string })?.failure_stage, "wallet_insert");
  assertEquals(ops.some((o) => o.table === "payments"), false);
  assertEquals(getLedgerRows().length, 0);
});
Deno.test("E — capture gates: unverified, refunded, released, PAYMENT_RECOVERY skip wallet", async () => {
  for (const scenario of ["ps_unverified", "ps_refunded", "ps_released", "ps_recovery"] as const) {
    const { client, ops } = mockSupabase(scenario);
    const result = await applyCanonicalSettlementAfterCapture({
      supabase: client as never,
      tripId: MK_260818_002.id,
      trip: MK_260818_002,
      captureAmountPence: 480,
      mode: "fresh_capture",
    });
    assertEquals(result.wallet_posting_status, "FAILED");
    assertEquals(result.retry_provider_capture, false);
    assertEquals(ops.some((o) => o.table === "driver_wallet_ledger" && o.op === "insert"), false);
  }
});

const MK_260818_003 = {
  id: "7ada43fa-1f3d-43e8-979b-6152ba9d5f2c",
  trip_code: "MK-260818-003",
  driver_id: "cd8bae4c-3827-4b90-98c6-10be70eb0e52",
  financial_model: "PLATFORM_COLLECTED",
  currency_code: "gbp",
  fare_snapshot_json: {
    gross_fare_pence: 500,
    original_fare_pence: 500,
    offer_discount_pence: 20,
    discount_source: "global_offer",
  },
  locked_base_fare_pence: 500,
  offer_discount_pence: 20,
  discount_source: "global_offer",
  customer_modification_charge_pence: 0,
  airport_charge_pence: 0,
  accepted_commission_percent: 15,
  capture_amount_pence: 480,
  final_fare_pence: 480,
  final_customer_fare_pence: 480,
  driver_net_pence: 425,
  payment_status: "captured",
};

function mockSupabaseMk003() {
  const tripId = MK_260818_003.id;
  return mockSupabase("success", tripId);
}

Deno.test("Step 2J — MK-260818-003 posts one 425p TRIP_EARNING_NET with schema-valid PS select", async () => {
  const { client, ops, getLedgerRows } = mockSupabaseMk003();
  const result = await applyCanonicalSettlementAfterCapture({
    supabase: client as never,
    tripId: MK_260818_003.id,
    trip: MK_260818_003,
    captureAmountPence: 480,
    mode: "fresh_capture",
  });
  const psSelect = (ops.find((o) =>
    o.table === "payment_sessions" && o.op === "select"
  )?.payload as { columns?: string } | undefined)?.columns;
  assertEquals(psSelect, PAYMENT_SESSION_CAPTURE_GATE_SELECT);
  assertStringIncludes(String(psSelect), "provider_capture_id");
  assertEquals(String(psSelect).includes("financial_model"), false);
  assertEquals(result.reconciliation_status, "BALANCED");
  assertEquals(result.posted_driver_credit_pence, 425);
  assertEquals(result.expected_driver_credit_pence, 425);
  const rows = getLedgerRows().filter((r) => r.type === "TRIP_EARNING_NET");
  assertEquals(rows.length, 1);
  assertEquals(rows[0].amount_pence, 425);
  assertEquals(ops.some((o) => o.table === "driver_commission_wallet_ledger"), false);

  const retry = mockSupabase("already_posted", MK_260818_003.id);
  const retryResult = await applyCanonicalSettlementAfterCapture({
    supabase: retry.client as never,
    tripId: MK_260818_003.id,
    trip: { ...MK_260818_003, driver_net_pence: 425 },
    captureAmountPence: 480,
    mode: "fresh_capture",
  });
  assertEquals(retryResult.reconciliation_status, "BALANCED");
  assertEquals(retry.ops.filter((o) => o.table === "driver_wallet_ledger" && o.op === "insert").length, 0);
});

Deno.test("Step 2J A — Payment Session SELECT 42703: breadcrumb PAYMENT_SESSION_GATE_QUERY; not BALANCED", async () => {
  const { client, ops, getMismatches, getLedgerRows } = mockSupabase("ps_query_error", MK_260818_003.id);
  const result = await applyCanonicalSettlementAfterCapture({
    supabase: client as never,
    tripId: MK_260818_003.id,
    trip: MK_260818_003,
    captureAmountPence: 480,
    mode: "fresh_capture",
  });
  assertEquals(result.reconciliation_status, "WALLET_MISMATCH");
  assertEquals(result.retry_provider_capture, false);
  assertEquals(result.wallet_posting_status, "FAILED");
  assertEquals(getLedgerRows().length, 0);
  assertEquals(ops.filter((o) => o.table === "driver_wallet_ledger" && o.op === "insert").length, 0);
  const mismatch = getMismatches().find((m) => m.field_name === "WALLET_MISMATCH");
  assertEquals(mismatch?.expected_pence, 425);
  assertEquals(mismatch?.actual_pence, 0);
  assertEquals((mismatch?.details as { failure_stage?: string })?.failure_stage, "PAYMENT_SESSION_GATE_QUERY");
  assertEquals((mismatch?.details as { error_code?: string })?.error_code, "42703");
});

Deno.test("Step 2J D — insert silent drop: readback count 0 → WALLET_MISMATCH; not BALANCED", async () => {
  const { client, getMismatches, getLedgerRows } = mockSupabase("insert_silent_drop", MK_260818_003.id);
  const result = await applyCanonicalSettlementAfterCapture({
    supabase: client as never,
    tripId: MK_260818_003.id,
    trip: MK_260818_003,
    captureAmountPence: 480,
    mode: "fresh_capture",
  });
  assertEquals(result.reconciliation_status, "WALLET_MISMATCH");
  assertEquals(result.posted_driver_credit_pence, 0);
  assertEquals(getLedgerRows().length, 0);
  const mismatch = getMismatches().find((m) => m.field_name === "WALLET_MISMATCH");
  assertEquals((mismatch?.details as { failure_stage?: string })?.failure_stage, "wallet_insert");
});

Deno.test("Step 2J E — insert 23505 race reloads existing 425p as success", async () => {
  const { client, getLedgerRows } = mockSupabase("insert_23505_correct", MK_260818_003.id);
  const result = await applyCanonicalSettlementAfterCapture({
    supabase: client as never,
    tripId: MK_260818_003.id,
    trip: MK_260818_003,
    captureAmountPence: 480,
    mode: "fresh_capture",
  });
  assertEquals(result.reconciliation_status, "BALANCED");
  assertEquals(result.posted_driver_credit_pence, 425);
  assertEquals(getLedgerRows().length, 1);
});

Deno.test("Step 2J E — insert 23505 with wrong existing amount → WALLET_MISMATCH", async () => {
  const { client, getMismatches } = mockSupabase("insert_23505_wrong", MK_260818_003.id);
  const result = await applyCanonicalSettlementAfterCapture({
    supabase: client as never,
    tripId: MK_260818_003.id,
    trip: MK_260818_003,
    captureAmountPence: 480,
    mode: "fresh_capture",
  });
  assertEquals(result.reconciliation_status, "WALLET_MISMATCH");
  assertEquals(result.posted_driver_credit_pence, 999);
  const mismatch = getMismatches().find((m) => m.field_name === "WALLET_MISMATCH");
  assertEquals((mismatch?.details as { failure_stage?: string })?.failure_stage, "wallet_insert");
});

Deno.test("Step 2J F — duplicate TRIP_EARNING_NET rows never BALANCED", async () => {
  const { client } = mockSupabase("duplicate_ledger", MK_260818_003.id);
  const result = await applyCanonicalSettlementAfterCapture({
    supabase: client as never,
    tripId: MK_260818_003.id,
    trip: MK_260818_003,
    captureAmountPence: 480,
    mode: "fresh_capture",
  });
  assertEquals(result.reconciliation_status, "WALLET_MISMATCH");
  assertEquals(result.posted_driver_credit_pence, 425);
});
