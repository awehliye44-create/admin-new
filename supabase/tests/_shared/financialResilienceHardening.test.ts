/**
 * LOCK — Financial Resilience programme (20261217100000).
 *
 * - Airport earnings stay payable: TRIP_EARNING_NET = driver_net + airport (SQL and TS).
 * - Refund application cannot fail on payments.provider_refund_id; the reversal follows the
 *   credited driver and is sized from the credited earning (airport included).
 * - A driver with deleted_at set never passes the payout gate.
 * - Earlier weekly runs close only when every item settled without a live intent/reservation.
 * - "Paid this month" counts each payout once at the net amount sent.
 * - Server-key admin actions still write their audit row.
 * - A refund Revolut holds but ONECAB never recorded is reconciled, never sent again.
 *
 * If this fails, fix the code — never delete or soften the lock.
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { fetchDriverPayoutEligibility } from "../../functions/_shared/fetchDriverPayoutEligibility.ts";
import {
  countActiveReservationsForEarlierRun,
  countBlockingIntentsForEarlierRun,
  ORCHESTRATOR_RUN_STATUS,
  resolveEarlierOccurrenceRunClose,
} from "../../functions/_shared/weeklyPayoutOrchestratorSSOT.ts";
import { sumCompletedDriverPayoutsThisMonthPence } from "../../functions/_shared/payoutLedgerCompanyFundingSSOT.ts";
import { auditAdminUserId } from "../../functions/_shared/adminPaymentGate.ts";
import { createFakeDb } from "./waitingSsotFakeDb.ts";

const read = (rel: string) => Deno.readTextFileSync(new URL(rel, import.meta.url));
const MIGRATION = read("../../migrations/20261217100000_financial_resilience_hardening.sql");
const ROLLBACK = read("../../migrations/rollback/rollback_20261217100000_financial_resilience_hardening.sql");

const NOW_MS = Date.parse("2026-10-13T12:00:00.000Z");
const ago = (h: number) => new Date(NOW_MS - h * 3600_000).toISOString();
const DRIVER = "00000000-0000-4000-8000-00000000a001";

function completedTrip(id: string, sessionId: string, net: number, airport: number) {
  return {
    trip: {
      id,
      payment_session_id: sessionId,
      status: "completed",
      financial_outcome: "COMPLETED",
      payment_status: "captured",
      no_show_charge_pence: null,
      financial_model: "PLATFORM_COLLECTED",
      payment_collection_model: null,
      payment_method: "card",
      driver_net_pence: net,
      airport_charge_pence: airport,
      tip_pence: 0,
      tip_amount_pence: 0,
      cancelled_at: null,
      completed_at: ago(96),
      settlement_formula_version: null,
      provider_available_on: null,
      driver_id: DRIVER,
      confirmed_driver_id: null,
      previous_driver_id: null,
    },
    session: {
      id: sessionId,
      trip_id: id,
      status: "captured",
      provider_state: "COMPLETED",
      captured_amount_pence: net + airport + 200,
      refunded_amount_pence: 0,
      captured_at: ago(96),
      payment_method: "card",
      metadata: {},
      provider_processing_fee_pence: 30,
      fee_status: "ACTUAL",
    },
  };
}

Deno.test("D2 [TS]: an airport trip's earning (net + airport) is eligible, not rejected", async () => {
  const airport = completedTrip("00000000-0000-4000-9000-00000000a001", "00000000-0000-4000-a000-00000000a001", 1000, 500);
  const plain = completedTrip("00000000-0000-4000-9000-00000000a002", "00000000-0000-4000-a000-00000000a002", 800, 0);
  const db = createFakeDb({
    drivers: [{ id: DRIVER, payouts_enabled: true, payout_operational_paused: false, approval_status: "approved", driver_status: "active" }],
    driver_wallet_ledger: [
      { id: "00000000-0000-4000-b000-00000000a001", driver_id: DRIVER, type: "TRIP_EARNING_NET", amount_pence: 1500, related_trip_id: airport.trip.id, created_at: ago(96), metadata: {} },
      { id: "00000000-0000-4000-b000-00000000a002", driver_id: DRIVER, type: "TRIP_EARNING_NET", amount_pence: 800, related_trip_id: plain.trip.id, created_at: ago(96), metadata: {} },
    ],
    driver_early_cashouts: [],
    driver_payout_destinations: [],
    admin_settings: [{ setting_key: "payout_clearing_delay_hours", setting_value: "27" }],
    trips: [airport.trip, plain.trip],
    payment_sessions: [airport.session, plain.session],
    driver_earning_settlement: [],
    payout_item_ledger_allocations: [],
  });
  const realNow = Date.now;
  Date.now = () => NOW_MS;
  try {
    // deno-lint-ignore no-explicit-any
    const r = await fetchDriverPayoutEligibility(db.client as any, { driver_id: DRIVER });
    assertEquals(r.eligible_earnings_pence, 2300);
    assertEquals(r.eligible_entries.map((e) => e.amount_pence).sort((a, b) => a - b), [800, 1500]);
  } finally {
    Date.now = realNow;
  }
});

Deno.test("D2 [SQL]: eligibility compares TRIP_EARNING_NET against driver_net + airport", () => {
  assertStringIncludes(MIGRATION, "      t.airport_charge_pence,\n");
  assertStringIncludes(
    MIGRATION,
    "v_canonical := GREATEST(0, COALESCE(r.driver_net_pence, 0) + COALESCE(r.airport_charge_pence, 0));",
  );
});

Deno.test("Refund application: payments.provider_refund_id exists and rollback keeps it", () => {
  assertStringIncludes(MIGRATION, "ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS provider_refund_id text;");
  assert(!/DROP COLUMN[^;]*provider_refund_id/i.test(ROLLBACK), "rollback must not drop payments.provider_refund_id");
});

Deno.test("D4/D5: refund reversal follows the credited driver and the credited earning", () => {
  const fn = MIGRATION.slice(MIGRATION.indexOf("FUNCTION public.apply_confirmed_provider_refund_atomic"));
  const body = fn.slice(0, fn.indexOf("$function$;"));
  assertStringIncludes(body, "SELECT dwl.driver_id INTO v_wallet_driver_id");
  assertStringIncludes(body, "public.trip_terminal_entitled_driver_id(");
  assertStringIncludes(body, "WHEN v_earning_credit_pence > 0 THEN v_earning_credit_pence");
  assertStringIncludes(body, "coalesce(v_trip.driver_net_pence, 0) + coalesce(v_trip.airport_charge_pence, 0)");
  assertStringIncludes(body, "AND v_wallet_driver_id IS NOT NULL\n     AND v_existing_debit_id IS NULL THEN");
  const stray = body.replace(/trip_terminal_entitled_driver_id\(\s*v_trip\.driver_id,/, "");
  assert(!stray.includes("v_trip.driver_id"), "reversal must never key on the mutable trips.driver_id");
});

Deno.test("Deleted driver: payout gate refuses deleted_at even if driver_status was not updated", () => {
  assertStringIncludes(MIGRATION, "      OR d.deleted_at IS NOT NULL\n");
});

Deno.test("D10: earlier run closes only when every item settled, never with a live intent or reservation", () => {
  const settled = resolveEarlierOccurrenceRunClose([
    { status: "COMPLETED", execution_status: "COMPLETED", open_intent_count: 0, active_reservation_count: 0 },
    { status: "CANCELLED", execution_status: "CANCELLED", open_intent_count: 0, active_reservation_count: 0 },
  ]);
  assertEquals(settled.close, true);
  assertEquals(settled.run_status, ORCHESTRATOR_RUN_STATUS.COMPLETED);
  assertEquals(settled.money_path_executed, true);

  const onlyCancelled = resolveEarlierOccurrenceRunClose([
    { status: "CANCELLED", execution_status: "CANCELLED", open_intent_count: 0, active_reservation_count: 0 },
  ]);
  assertEquals(onlyCancelled.close, true);
  assertEquals(onlyCancelled.money_path_executed, false);

  for (const st of ["SUBMITTED", "RESERVED", "FAILED", "FAILED_RETRYABLE", "UNKNOWN", "VALIDATED"]) {
    const r = resolveEarlierOccurrenceRunClose([
      { status: "COMPLETED", execution_status: "COMPLETED", open_intent_count: 0, active_reservation_count: 0 },
      { status: st, execution_status: st, open_intent_count: 0, active_reservation_count: 0 },
    ]);
    assertEquals(r.close, false, st);
  }
  assertEquals(resolveEarlierOccurrenceRunClose([]).close, false);
  assertEquals(
    resolveEarlierOccurrenceRunClose([
      { status: "CANCELLED", execution_status: "CANCELLED", open_intent_count: 1, active_reservation_count: 0 },
    ]).close,
    false,
  );
  assertEquals(
    resolveEarlierOccurrenceRunClose([
      { status: "COMPLETED", execution_status: "COMPLETED", open_intent_count: 0, active_reservation_count: 1 },
    ]).close,
    false,
  );
});

Deno.test("D10: a cancelled item with any intent blocks; a completed item ignores final intents", () => {
  assertEquals(countBlockingIntentsForEarlierRun("CANCELLED", ["FAILED"]), 1);
  assertEquals(countBlockingIntentsForEarlierRun("COMPLETED", ["COMPLETED", "FAILED"]), 0);
  assertEquals(countBlockingIntentsForEarlierRun("COMPLETED", ["COMPLETED", "SUBMITTED"]), 1);
  assertEquals(countActiveReservationsForEarlierRun(["CONSUMED", "RELEASED"]), 0);
  assertEquals(countActiveReservationsForEarlierRun(["ACTIVE"]), 1);
});

Deno.test("D10: executor sweep is compare-and-set on RUNNING and never writes money tables", () => {
  const src = read("../../functions/admin-execute-weekly-payout-occurrence/index.ts");
  const start = src.indexOf("async function closeSettledEarlierOccurrenceRuns");
  const sweep = src.slice(start, src.indexOf("\n}\n", start));
  assertStringIncludes(sweep, '.eq("status", ORCHESTRATOR_RUN_STATUS.RUNNING)');
  assertStringIncludes(sweep, '.eq("dry_run", false)');
  for (const forbidden of ["driver_wallet_ledger", ".rpc(", "payout_items\").update", "reservations\").update"]) {
    assert(!sweep.includes(forbidden), `sweep must not touch ${forbidden}`);
  }
  assertStringIncludes(src, "const earlierRunsClosed = dryRun ? [] : await closeSettledEarlierOccurrenceRuns(supabase, runId);");
});

Deno.test("D7: early cash-out counted once at the net sent, not gross + net", () => {
  const at = "2026-09-20T10:00:00.000Z";
  const total = sumCompletedDriverPayoutsThisMonthPence({
    month_start_iso: "2026-08-31T23:00:00.000Z",
    executions: [
      { driver_id: "d1", payout_item_id: "item-1", amount_pence: 4555, provider_state: "completed", financially_applied: true, financially_applied_at: at },
      { driver_id: "d1", payout_item_id: "item-1", is_payout_item_row: true, amount_pence: 4505, item_status: "COMPLETED", completed_at: at },
      { driver_id: "d1", payout_item_id: "item-2", is_payout_item_row: true, amount_pence: 1000, item_status: "COMPLETED", completed_at: at },
      { driver_id: "d1", payout_item_id: "item-3", is_payout_item_row: true, amount_pence: 1000, item_status: "COMPLETED", completed_at: at },
    ],
  });
  assertEquals(total, 4505 + 1000 + 1000);
});

Deno.test("Audit actor: server-key callers write a null actor instead of an invalid uuid", () => {
  assertEquals(auditAdminUserId("service-role"), null);
  assertEquals(auditAdminUserId("5ed232c3-8bb5-4085-95d6-73e48e6c5e28"), "5ed232c3-8bb5-4085-95d6-73e48e6c5e28");
  for (const fn of [
    "admin-capture-trip-payment",
    "admin-cancel-trip-payment",
    "admin-refund-trip-payment",
    "admin-request-extra-payment",
    "admin-add-trip-finance-note",
    "admin-hold-action",
    "admin-recapture-trip-shortfall",
    "revolut-cancel-order",
  ]) {
    const src = read(`../../functions/${fn}/index.ts`);
    assertStringIncludes(src, "admin_user_id: auditAdminUserId(gate.userId)", fn);
  }
});

Deno.test("Refunds: an unrecorded Revolut refund blocks a second refund; legacy route retired", () => {
  const refund = read("../../functions/admin-refund-trip-payment/index.ts");
  assertStringIncludes(refund, "if (providerRefunded > alreadyRefunded) {");
  assertStringIncludes(refund, 'failure_stage: "refund_reconciliation_required"');
  assert(
    refund.indexOf("providerRefunded > alreadyRefunded") < refund.indexOf("refundRevolutOrder(environment"),
    "reconciliation check must run before any provider refund call",
  );
  const legacy = read("../../functions/revolut-refund-order/index.ts");
  assertStringIncludes(legacy, '"REFUND_ROUTE_RETIRED"');
  assert(!legacy.includes("refundRevolutOrder"), "retired route must not call the provider");
});
