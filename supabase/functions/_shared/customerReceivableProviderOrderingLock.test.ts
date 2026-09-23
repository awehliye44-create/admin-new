/**
 * Lock: provider ordering for customer receivable preauth fold.
 * create session → lock → select OPEN → RESERVED allocations → commit
 * → fare+reserved → Revolut call
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  PREAUTH_RECEIVABLE_ORDERING,
  planFoldReceivablesIntoPreauth,
  planReserveBeforeProviderCall,
  CUSTOMER_RECEIVABLE_STATUS,
} from "./customerReceivableSSOT.ts";

Deno.test("preauth ordering constants are exact sequence", () => {
  assertEquals([...PREAUTH_RECEIVABLE_ORDERING], [
    "CREATE_PENDING_PAYMENT_SESSION",
    "ACQUIRE_CUSTOMER_RECEIVABLE_LOCK",
    "SELECT_OPEN_RECEIVABLES_FOR_UPDATE",
    "CREATE_RESERVED_ALLOCATIONS",
    "COMMIT_DURABLE_RESERVATION",
    "CALCULATE_FARE_PLUS_RESERVED",
    "CALL_REVOLUT_PREAUTH",
  ]);
});

Deno.test("planReserveBeforeProviderCall requires pending session", () => {
  const blocked = planReserveBeforeProviderCall({
    has_pending_payment_session: false,
    open_receivable_count: 2,
  });
  assertEquals(blocked.ok, false);
  assertEquals(blocked.must_persist_reservation_before_provider, true);

  const ok = planReserveBeforeProviderCall({
    has_pending_payment_session: true,
    open_receivable_count: 2,
  });
  assertEquals(ok.ok, true);
  assertEquals(ok.steps[ok.steps.length - 1], "CALL_REVOLUT_PREAUTH");
  assertEquals(ok.steps[0], "CREATE_PENDING_PAYMENT_SESSION");
});

Deno.test("fare + reserved computed only after reservation plan", () => {
  const fold = planFoldReceivablesIntoPreauth({
    ride_fare_pence: 800,
    buffer_pence: 100,
    open_receivables: [
      {
        id: "r1",
        customer_id: "c1",
        outstanding_amount_pence: 30,
        status: CUSTOMER_RECEIVABLE_STATUS.OPEN,
        currency: "gbp",
        source_trip_id: "t1",
        idempotency_key: "k1",
        created_at: "2026-09-23T10:00:00Z",
      },
      {
        id: "r2",
        customer_id: "c1",
        outstanding_amount_pence: 6,
        status: CUSTOMER_RECEIVABLE_STATUS.OPEN,
        currency: "gbp",
        source_trip_id: "t2",
        idempotency_key: "k2",
        created_at: "2026-09-23T11:00:00Z",
      },
    ],
  });
  assertEquals(fold.receivables_total_pence, 36);
  assertEquals(fold.authorised_amount_pence, 936);
  // Revolut amount is fare+buffer+reserved — never fare alone when debt open.
  assertEquals(fold.authorised_amount_pence > fold.ride_fare_pence + fold.buffer_pence, true);
});

Deno.test("revolutPreauth source locks reservation before createRevolutOrder", async () => {
  const src = await Deno.readTextFile(
    new URL("./revolutPreauth.ts", import.meta.url),
  );
  assertEquals(src.includes("PREAUTH_RECEIVABLE_ORDERING"), true);
  assertEquals(src.includes("RECEIVABLE_PERSISTENCE_UNAVAILABLE"), true);
  assertEquals(src.includes("reserveReceivablesBeforeProviderCall"), true);

  // Call-site ordering: durable reserve must appear before first postPreauthOrder invoke.
  const reserveCall = src.indexOf(
    "await reserveReceivablesBeforeProviderCall(supabase",
  );
  const orderInvoke = src.indexOf("order = await postPreauthOrder(");
  const pendingBeforeReserve = src.lastIndexOf(
    "upsertPaymentSessionPending(supabase",
    reserveCall,
  );
  assertEquals(reserveCall > 0, true);
  assertEquals(orderInvoke > 0, true);
  assertEquals(pendingBeforeReserve > 0 && pendingBeforeReserve < reserveCall, true);
  assertEquals(reserveCall < orderInvoke, true);
});
