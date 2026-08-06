/**
 * Regression tests: service-area aggregation scope + pre-send gate + smoke budget.
 */
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  aggregateLedgerRowsPure,
  CANONICAL_LEGACY_NULL_SA_RULE,
  filterLedgerRowsByScope,
  resolveAggregationScope,
} from "./driverInvoiceAggregationScope.ts";
import {
  canTransitionLifecycle,
  validateDriverInvoicePreSend,
} from "./driverInvoicePreSendGate.ts";
import {
  acquireSmokeSendSlotPure,
  releaseSmokeSendSlotPure,
  runSmokeBudgetSendSequence,
  simulateConcurrentSmokeAcquires,
} from "./invoiceSmokeSendBudget.ts";

const SA = "sa-milton-keynes";
const rows = [
  { id: "a", type: "TRIP_EARNING_NET", amount_pence: 1000, service_area_id: SA },
  { id: "b", type: "TRIP_EARNING_NET", amount_pence: 500, service_area_id: "sa-other" },
  { id: "c", type: "TRIP_EARNING_NET", amount_pence: 200, service_area_id: null },
  { id: "d", type: "PLATFORM_COMMISSION", amount_pence: -100, service_area_id: SA },
];

Deno.test("SA1: global report with null service_area_id includes eligible rows", () => {
  assertEquals(resolveAggregationScope(null), "global");
  assertEquals(resolveAggregationScope(""), "global");
  const { scoped } = filterLedgerRowsByScope(rows, null);
  assertEquals(scoped.length, 4);
  const out = aggregateLedgerRowsPure(rows, { serviceAreaId: null });
  assertEquals(out.ok, true);
  assertEquals(out.netDriverEarningsPence, 1000 + 500 + 200 - 100);
  assert(out.includedRowCount > 0);
});

Deno.test("SA2: explicit service-area report includes only that area", () => {
  const { scoped, excludedByScope } = filterLedgerRowsByScope(rows, SA);
  assertEquals(scoped.map((r) => r.id).sort(), ["a", "d"]);
  assertEquals(excludedByScope.map((r) => r.id).sort(), ["b", "c"]);
  const out = aggregateLedgerRowsPure(rows, { serviceAreaId: SA });
  assertEquals(out.netDriverEarningsPence, 1000 - 100);
});

Deno.test("SA3: ledger rows lacking SA metadata follow canonical exclude-under-SA-scope", () => {
  assertEquals(CANONICAL_LEGACY_NULL_SA_RULE, "exclude_from_service_area_scope");
  const { scoped } = filterLedgerRowsByScope(
    [{ id: "legacy", type: "TRIP_EARNING_NET", amount_pence: 999, service_area_id: null }],
    SA,
  );
  assertEquals(scoped.length, 0);
});

Deno.test("SA4: empty eligible period distinguished from query/filter failure", () => {
  const empty = aggregateLedgerRowsPure([], { serviceAreaId: null });
  assertEquals(empty.ok, true);
  assertEquals(empty.zeroTotalClassification, "VALID_ZERO_EARNINGS");
  assertEquals(empty.failureCode, null);

  const failed = aggregateLedgerRowsPure([], { serviceAreaId: null, queryFailed: true });
  assertEquals(failed.ok, false);
  assertEquals(failed.zeroTotalClassification, "INCOMPLETE_AGGREGATION");
  assertEquals(failed.failureCode, "AGGREGATION_QUERY_FAILED");

  const misuse = aggregateLedgerRowsPure([], {
    serviceAreaId: null,
    nullServiceAreaFilterApplied: true,
  });
  assertEquals(misuse.ok, false);
  assertEquals(misuse.failureCode, "NULL_SERVICE_AREA_FILTER_MISUSE");
});

Deno.test("SA5: failed aggregation cannot progress to SEND_PENDING", () => {
  const gate = validateDriverInvoicePreSend({
    driverId: "d1",
    periodStart: "2026-07-01",
    periodEnd: "2026-07-31",
    lifecycleStatus: "VALIDATED",
    status: "validated",
    aggregation: aggregateLedgerRowsPure([], { queryFailed: true }),
    renderedNetPence: 0,
    providerMessageId: null,
    invoiceEmailSent: false,
    smokeRunId: null,
    recipientDriverId: "d1",
    allowlistedDriverIds: [],
    smokeBudgetOk: true,
  });
  assertEquals(gate.ok, false);
  if (!gate.ok) assertEquals(gate.code, "AGGREGATION_QUERY_FAILED");
  assertEquals(canTransitionLifecycle("AGGREGATING", "SEND_PENDING"), false);
});

Deno.test("SA6: report changed after validation must be revalidated before sending", () => {
  const stale = validateDriverInvoicePreSend({
    driverId: "d1",
    periodStart: "2026-07-01",
    periodEnd: "2026-07-31",
    lifecycleStatus: "DRAFT", // reset after mutation
    status: "draft",
    aggregation: aggregateLedgerRowsPure(rows, { serviceAreaId: null }),
    renderedNetPence: 1600,
    providerMessageId: null,
    invoiceEmailSent: false,
    smokeRunId: null,
    recipientDriverId: "d1",
    allowlistedDriverIds: [],
    smokeBudgetOk: true,
  });
  assertEquals(stale.ok, false);
  if (!stale.ok) assertEquals(stale.code, "NOT_VALIDATED");

  const ok = validateDriverInvoicePreSend({
    driverId: "d1",
    periodStart: "2026-07-01",
    periodEnd: "2026-07-31",
    lifecycleStatus: "VALIDATED",
    status: "validated",
    aggregation: aggregateLedgerRowsPure(rows, { serviceAreaId: null }),
    renderedNetPence: 1600,
    providerMessageId: null,
    invoiceEmailSent: false,
    smokeRunId: null,
    recipientDriverId: "d1",
    allowlistedDriverIds: [],
    smokeBudgetOk: true,
  });
  assertEquals(ok.ok, true);
});

Deno.test("BUDGET: requests 1–4 acquire; request 5 → SMOKE_SEND_LIMIT_REACHED with 0 extra provider calls", () => {
  const seq = runSmokeBudgetSendSequence(4, 5);
  assertEquals(seq.providerCalls, 4);
  assertEquals(seq.successes, 4);
  assertEquals(seq.fifthRejected, true);
  assertEquals(seq.final.successful_send_count, 4);
  assertEquals(seq.final.max_successful_sends, 4);
});

Deno.test("BUDGET: concurrent claimants cannot share the final slot", () => {
  const { winners, results } = simulateConcurrentSmokeAcquires({
    smoke_run_id: "SMOKE-TEST",
    status: "open",
    max_successful_sends: 4,
    successful_send_count: 3,
    attempted_send_count: 3,
    reserved_send_count: 0,
  }, 3);
  assertEquals(winners, 1);
  assertEquals(results.filter((r) => !r.ok && r.code === "SMOKE_SEND_LIMIT_REACHED").length, 2);
});

Deno.test("BUDGET: failed provider does not increment successful (release after acquire)", () => {
  let state: import("./invoiceSmokeSendBudget.ts").SmokeBudgetState = {
    smoke_run_id: "SMOKE-TEST",
    status: "open",
    max_successful_sends: 4,
    successful_send_count: 0,
    attempted_send_count: 0,
    reserved_send_count: 0,
  };
  const a = acquireSmokeSendSlotPure(state);
  assert(a.ok);
  if (a.ok) state = a.state;
  state = releaseSmokeSendSlotPure(state);
  assertEquals(state.successful_send_count, 0);
  assertEquals(state.reserved_send_count, 0);
  assertEquals(state.attempted_send_count, 1);
});
