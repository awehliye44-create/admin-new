/**
 * Lock tests for paymentSessionLifecycleFinalizer.ts
 * Covers: strict compare-and-set, conflicting/refunded/reversed sessions fail closed,
 * DRIVER_COLLECTED cannot enter this workflow, idempotency.
 */
import { assertEquals } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import {
  checkPsLifecycleFinalizerPreconditions,
  finalizePaymentSessionLifecycleMismatch,
} from "./paymentSessionLifecycleFinalizer.ts";

function baseSession(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "ps-test-001",
    status: "trip_created",
    financial_model: "PLATFORM_COLLECTED",
    purpose: "RIDE_BOOKING",
    provider_order_id: "rev-order-001",
    provider_capture_id: "rev-cap-001",
    provider_state: "COMPLETED",
    provider_state_verified_at: "2026-08-17T18:50:46.000Z",
    captured_amount_pence: 480,
    refunded_amount_pence: null,
    hold_release_state: null,
    financial_operation_state: "CAPTURING",
    financial_operation_owner: "finalize-trip-and-capture",
    metadata: {},
    ...overrides,
  };
}

Deno.test("preconditions: eligible session returns null (no blocking reason)", () => {
  const result = checkPsLifecycleFinalizerPreconditions(baseSession());
  assertEquals(result, null);
});

Deno.test("preconditions: already_captured is reported — caller treats as idempotent", () => {
  const result = checkPsLifecycleFinalizerPreconditions(baseSession({ status: "captured" }));
  assertEquals(result, "already_captured");
});

Deno.test("preconditions: refund exists — fails closed", () => {
  const result = checkPsLifecycleFinalizerPreconditions(
    baseSession({ refunded_amount_pence: 100 }),
  );
  assertEquals(result, "refund_exists_cannot_finalize");
});

Deno.test("preconditions: hold already released — fails closed", () => {
  const result = checkPsLifecycleFinalizerPreconditions(
    baseSession({ hold_release_state: "released" }),
  );
  assertEquals(result, "hold_already_released");
});

Deno.test("preconditions: provider_state not COMPLETED/CAPTURED — fails closed", () => {
  assertEquals(
    checkPsLifecycleFinalizerPreconditions(baseSession({ provider_state: "AUTHORISED" })),
    "provider_state_not_captured:AUTHORISED",
  );
  assertEquals(
    checkPsLifecycleFinalizerPreconditions(baseSession({ provider_state: "CANCELLED" })),
    "provider_state_not_captured:CANCELLED",
  );
});

Deno.test("preconditions: provider_state_verified_at missing — fails closed", () => {
  const result = checkPsLifecycleFinalizerPreconditions(
    baseSession({ provider_state_verified_at: null }),
  );
  assertEquals(result, "provider_state_not_verified");
});

Deno.test("preconditions: captured_amount_pence zero — fails closed", () => {
  const result = checkPsLifecycleFinalizerPreconditions(
    baseSession({ captured_amount_pence: 0 }),
  );
  assertEquals(result, "captured_amount_missing_or_zero");
});

Deno.test("preconditions: captured amount must agree with persisted provider evidence", () => {
  const result = checkPsLifecycleFinalizerPreconditions(
    baseSession({ metadata: { capture_amount_pence: 481 } }),
  );
  assertEquals(result, "captured_amount_disagrees_with_persisted_provider_evidence");
});

Deno.test("preconditions: contradictory terminal reason fails closed", () => {
  const result = checkPsLifecycleFinalizerPreconditions(
    baseSession({ hold_terminal_reason: "provider_cancelled" }),
  );
  assertEquals(result, "contradictory_hold_terminal_reason:PROVIDER_CANCELLED");
});

Deno.test("preconditions: financial_operation_state must be recoverable", () => {
  const result = checkPsLifecycleFinalizerPreconditions(
    baseSession({ financial_operation_state: "IDLE" }),
  );
  assertEquals(result, "financial_operation_state_not_recoverable:IDLE");
});

Deno.test("preconditions: status not in recoverable set — fails closed", () => {
  const result = checkPsLifecycleFinalizerPreconditions(
    baseSession({ status: "cancelled" }),
  );
  assertEquals(result?.startsWith("status_not_recoverable"), true);
});

Deno.test("preconditions: DRIVER_COLLECTED financial_model — fails closed", () => {
  const result = checkPsLifecycleFinalizerPreconditions(
    baseSession({ financial_model: "DRIVER_COLLECTED_COMMISSION_WALLET" }),
  );
  assertEquals(result?.startsWith("financial_model_not_eligible"), true);
});

Deno.test("preconditions: purpose not RIDE_BOOKING — fails closed", () => {
  const result = checkPsLifecycleFinalizerPreconditions(
    baseSession({ purpose: "CARD_SETUP" }),
  );
  assertEquals(result?.startsWith("purpose_not_eligible"), true);
});

Deno.test("finalize: happy path — update succeeds, returns finalized:true", async () => {
  let updateCalled = false;
  let eqStatus: unknown;
  let eqOpState: unknown;
  let neqStatus: unknown;

  const mockSupabase = {
    from: (table: string) => {
      if (table === "payment_sessions") {
        return {
          select: () => ({
            eq: (_col: string, _val: unknown) => ({
              neq: (_col2: string, _val2: unknown) => Promise.resolve({ data: [{ id: "ps-test-001" }], error: null }),
            }),
          }),
          update: (_patch: unknown) => ({
            eq: (_col1: string, _val1: unknown) => ({
              eq: (_col2: string, val2: unknown) => {
                eqStatus = val2;
                return {
                  eq: (_col3: string, val3: unknown) => {
                    eqOpState = val3;
                    return {
                      neq: (_col4: string, val4: unknown) => {
                        neqStatus = val4;
                        updateCalled = true;
                        return Promise.resolve({ error: null });
                      },
                    };
                  },
                };
              },
            }),
          }),
        };
      }
      return {};
    },
  };

  const result = await finalizePaymentSessionLifecycleMismatch(
    mockSupabase as unknown as Parameters<typeof finalizePaymentSessionLifecycleMismatch>[0],
    baseSession(),
    { tripId: "trip-001", source: "test" },
  );

  assertEquals(result.finalized, true);
  assertEquals(updateCalled, true);
  assertEquals(eqStatus, "trip_created"); // compare-and-set checked exact current status
  assertEquals(eqOpState, "CAPTURING"); // compare-and-set checked current financial operation state
  assertEquals(neqStatus, "captured"); // never overwrite already-captured
});

Deno.test("finalize: DB error — returns finalized:false with reason", async () => {
  const mockSupabase = {
    from: (table: string) => {
      if (table === "payment_sessions") {
        return {
          select: () => ({
            eq: (_col: string, _val: unknown) => ({
              neq: (_col2: string, _val2: unknown) => Promise.resolve({ data: [{ id: "ps-test-001" }], error: null }),
            }),
          }),
          update: (_patch: unknown) => ({
            eq: (_col1: string, _val1: unknown) => ({
              eq: (_col2: string, _val2: unknown) => ({
                eq: (_col3: string, _val3: unknown) => ({
                  neq: (_col4: string, _val4: unknown) =>
                    Promise.resolve({ error: { message: "connection timeout", code: "57P01" } }),
                }),
              }),
            }),
          }),
        };
      }
      return {};
    },
  };

  const result = await finalizePaymentSessionLifecycleMismatch(
    mockSupabase as unknown as Parameters<typeof finalizePaymentSessionLifecycleMismatch>[0],
    baseSession(),
    { tripId: "trip-001", source: "test" },
  );

  assertEquals(result.finalized, false);
  assertEquals("reason" in result && result.reason.includes("db_update_failed"), true);
});

Deno.test("finalize: session without id — returns finalized:false immediately", async () => {
  const result = await finalizePaymentSessionLifecycleMismatch(
    {} as unknown as Parameters<typeof finalizePaymentSessionLifecycleMismatch>[0],
    { ...baseSession(), id: "" },
    { tripId: "trip-001", source: "test" },
  );
  assertEquals(result.finalized, false);
  assertEquals("reason" in result && result.reason, "session_id_missing");
});

Deno.test("finalize: idempotent — already captured returns finalized:true without DB write", async () => {
  let updateCalled = false;
  const mockSupabase = {
    from: (_table: string) => ({
      update: (_patch: unknown) => {
        updateCalled = true;
        return { eq: () => ({ eq: () => ({ eq: () => ({ neq: () => Promise.resolve({ error: null }) }) }) }) };
      },
    }),
  };

  const result = await finalizePaymentSessionLifecycleMismatch(
    mockSupabase as unknown as Parameters<typeof finalizePaymentSessionLifecycleMismatch>[0],
    baseSession({ status: "captured" }),
    { tripId: "trip-001", source: "test" },
  );

  assertEquals(result.finalized, true);
  assertEquals(updateCalled, false); // no DB write for already-captured
});

Deno.test("finalize: duplicate canonical capture identity — fails closed", async () => {
  const mockSupabase = {
    from: (table: string) => {
      if (table === "payment_sessions") {
        return {
          select: () => ({
            eq: (_col: string, _val: unknown) => ({
              neq: (_col2: string, _val2: unknown) =>
                Promise.resolve({ data: [{ id: "ps-test-001" }, { id: "ps-test-002" }], error: null }),
            }),
          }),
          update: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ neq: () => Promise.resolve({ error: null }) }) }) }) }),
        };
      }
      return {};
    },
  };

  const result = await finalizePaymentSessionLifecycleMismatch(
    mockSupabase as unknown as Parameters<typeof finalizePaymentSessionLifecycleMismatch>[0],
    baseSession(),
    { tripId: "trip-001", source: "test" },
  );
  assertEquals(result.finalized, false);
  assertEquals("reason" in result && result.reason, "duplicate_or_missing_canonical_capture_identity:provider_capture_id");
});

Deno.test("finalize: conflicting reversed session — fails closed before DB", async () => {
  let updateCalled = false;
  const mockSupabase = {
    from: () => ({
      update: () => {
        updateCalled = true;
        return { eq: () => ({ eq: () => ({ neq: () => Promise.resolve({ error: null }) }) }) };
      },
    }),
  };

  // Reversed: provider_state = CANCELLED but captured_amount_pence set — conflicting
  const result = await finalizePaymentSessionLifecycleMismatch(
    mockSupabase as unknown as Parameters<typeof finalizePaymentSessionLifecycleMismatch>[0],
    baseSession({ provider_state: "CANCELLED", captured_amount_pence: 480 }),
    { tripId: "trip-001", source: "test" },
  );

  assertEquals(result.finalized, false);
  assertEquals(updateCalled, false); // preconditions blocked before DB
});
