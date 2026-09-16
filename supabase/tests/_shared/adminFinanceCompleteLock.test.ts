/**
 * Admin Finance Complete — trip credit health, settlement diagnostic,
 * FR driver_id import, and payout-status separation locks.
 */
import {
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  classifyDriverCreditHealth,
  DRIVER_CREDIT_HEALTH,
  computeExpectedDriverCreditPence,
  sumActiveDriverWalletCreditForTrip,
  buildMissingLedgerDiagnosticRow,
  buildPaymentSessionDriverCreditFields,
} from "../../functions/_shared/driverCreditMonitoringSSOT.ts";
import { computeNextWeeklyPayoutRun } from "../../functions/_shared/payoutScheduleSSOT.ts";
import {
  computeNextWeeklyPayoutRun as computeNextFromPerDriver,
} from "../../functions/_shared/perDriverFinancialReconciliation.ts";

const DRIVER = "driver-a";

function tipLedger(tripId: string, fareNet: number, tip: number) {
  const rows: Array<{ type: string; amount_pence: number; driver_id: string; related_trip_id: string }> = [
    { type: "TRIP_EARNING_NET", amount_pence: fareNet, driver_id: DRIVER, related_trip_id: tripId },
  ];
  if (tip > 0) {
    rows.push({
      type: "DRIVER_TIP_CREDIT",
      amount_pence: tip,
      driver_id: DRIVER,
      related_trip_id: tripId,
    });
  }
  return rows;
}

Deno.test("F1: fare-only — expected = fare net, difference 0", () => {
  const ledger = tipLedger("t1", 425, 0);
  const r = classifyDriverCreditHealth({
    financial_model: "PLATFORM_COLLECTED",
    trip_status: "completed",
    trip_driver_id: DRIVER,
    driver_net_pence: 425,
    tip_pence: 0,
    ledger,
    wallet_evidence_available: true,
    provider_state: "CAPTURED",
    captured_pence: 500,
    captured_at: "2026-01-01T00:00:00Z",
    now_ms: Date.parse("2026-01-10T00:00:00Z"),
  });
  assertEquals(r.expected_driver_credit_pence, 425);
  assertEquals(r.actual_driver_credit_pence, 425);
  assertEquals(r.credit_difference_pence, 0);
  assertEquals(r.health, DRIVER_CREDIT_HEALTH.OK);
});

for (const tip of [1, 50, 100, 250, 500]) {
  Deno.test(`F1: fare + tip ${tip}p — component basis once, difference 0`, () => {
    const fareNet = 425;
    const ledger = tipLedger("t1", fareNet, tip);
    const r = classifyDriverCreditHealth({
      financial_model: "PLATFORM_COLLECTED",
      trip_status: "completed",
      trip_driver_id: DRIVER,
      driver_net_pence: fareNet,
      tip_pence: tip,
      ledger,
      wallet_evidence_available: true,
      provider_state: "CAPTURED",
      captured_pence: fareNet + tip + 75,
      captured_at: "2026-01-01T00:00:00Z",
      now_ms: Date.parse("2026-01-10T00:00:00Z"),
    });
    assertEquals(r.expected_driver_credit_pence, fareNet + tip);
    assertEquals(r.actual_driver_credit_pence, fareNet + tip);
    assertEquals(r.credit_difference_pence, 0);
    assertEquals(r.health, DRIVER_CREDIT_HEALTH.OK);
  });
}

Deno.test("F1: tip-inclusive entitlement must NOT be passed as driver_net (regression)", () => {
  // Wrong call shape that produced 625 expected / −100 diff.
  const wrong = classifyDriverCreditHealth({
    financial_model: "PLATFORM_COLLECTED",
    trip_status: "completed",
    trip_driver_id: DRIVER,
    driver_net_pence: 525, // tip already folded — incorrect input
    tip_pence: 100,
    ledger: tipLedger("t1", 425, 100),
    wallet_evidence_available: true,
    provider_state: "CAPTURED",
    captured_pence: 600,
    captured_at: "2026-01-01T00:00:00Z",
    now_ms: Date.parse("2026-01-10T00:00:00Z"),
  });
  assertEquals(wrong.expected_driver_credit_pence, 625);
  assertEquals(wrong.credit_difference_pence, -100);

  const correct = classifyDriverCreditHealth({
    financial_model: "PLATFORM_COLLECTED",
    trip_status: "completed",
    trip_driver_id: DRIVER,
    driver_net_pence: 425,
    tip_pence: 100,
    ledger: tipLedger("t1", 425, 100),
    wallet_evidence_available: true,
    provider_state: "CAPTURED",
    captured_pence: 600,
    captured_at: "2026-01-01T00:00:00Z",
    now_ms: Date.parse("2026-01-10T00:00:00Z"),
  });
  assertEquals(correct.expected_driver_credit_pence, 525);
  assertEquals(correct.actual_driver_credit_pence, 525);
  assertEquals(correct.credit_difference_pence, 0);
  assertEquals(correct.health, DRIVER_CREDIT_HEALTH.OK);
});

Deno.test("F1: fare + airport component — airport not added again on top of fare net", () => {
  // Airport already folded into driver_net (1350 includes 500 airport).
  const fareNetIncludingAirport = 1350;
  const r = classifyDriverCreditHealth({
    financial_model: "PLATFORM_COLLECTED",
    trip_status: "completed",
    trip_driver_id: DRIVER,
    driver_net_pence: fareNetIncludingAirport,
    tip_pence: 0,
    ledger: tipLedger("t1", fareNetIncludingAirport, 0),
    wallet_evidence_available: true,
    provider_state: "CAPTURED",
    captured_pence: 1600,
    captured_at: "2026-01-01T00:00:00Z",
    now_ms: Date.parse("2026-01-10T00:00:00Z"),
  });
  assertEquals(r.expected_driver_credit_pence, 1350);
  assertEquals(r.credit_difference_pence, 0);
});

Deno.test("F1: fare + airport + tip", () => {
  const r = classifyDriverCreditHealth({
    financial_model: "PLATFORM_COLLECTED",
    trip_status: "completed",
    trip_driver_id: DRIVER,
    driver_net_pence: 1350,
    tip_pence: 100,
    ledger: tipLedger("t1", 1350, 100),
    wallet_evidence_available: true,
    provider_state: "CAPTURED",
    captured_pence: 1700,
    captured_at: "2026-01-01T00:00:00Z",
    now_ms: Date.parse("2026-01-10T00:00:00Z"),
  });
  assertEquals(r.expected_driver_credit_pence, 1450);
  assertEquals(r.actual_driver_credit_pence, 1450);
  assertEquals(r.credit_difference_pence, 0);
  assertEquals(r.health, DRIVER_CREDIT_HEALTH.OK);
});

Deno.test("F2: trip-linked tip counted once; other-trip tip excluded", () => {
  const ledger = [
    ...tipLedger("t1", 425, 100),
    { type: "DRIVER_TIP_CREDIT", amount_pence: 100, driver_id: DRIVER, related_trip_id: "other" },
  ];
  // Classifier receives trip-scoped ledger only (caller filters by trip).
  const scoped = tipLedger("t1", 425, 100);
  const sum = sumActiveDriverWalletCreditForTrip({ ledger: scoped, trip_driver_id: DRIVER });
  assertEquals(sum.correct_driver_credit_pence, 525);
  assertEquals(sum.has_duplicate, false);
  // Untied / other-trip tip not in scoped ledger
  assertEquals(ledger.filter((e) => e.related_trip_id === "t1").length, 2);
});

Deno.test("F2: duplicate tip credit → over-credit", () => {
  const ledger = [
    { type: "TRIP_EARNING_NET", amount_pence: 425, driver_id: DRIVER },
    { type: "DRIVER_TIP_CREDIT", amount_pence: 100, driver_id: DRIVER },
    { type: "DRIVER_TIP_CREDIT", amount_pence: 100, driver_id: DRIVER },
  ];
  const sum = sumActiveDriverWalletCreditForTrip({ ledger, trip_driver_id: DRIVER });
  assertEquals(sum.has_duplicate, true);
  assertEquals(sum.correct_driver_credit_pence, 625);
  const r = classifyDriverCreditHealth({
    financial_model: "PLATFORM_COLLECTED",
    trip_status: "completed",
    trip_driver_id: DRIVER,
    driver_net_pence: 425,
    tip_pence: 100,
    ledger,
    wallet_evidence_available: true,
    provider_state: "CAPTURED",
    captured_pence: 600,
    captured_at: "2026-01-01T00:00:00Z",
    now_ms: Date.parse("2026-01-10T00:00:00Z"),
  });
  assertEquals(r.health, DRIVER_CREDIT_HEALTH.DUPLICATE);
});

Deno.test("F2: missing tip credit → under-credit", () => {
  const r = classifyDriverCreditHealth({
    financial_model: "PLATFORM_COLLECTED",
    trip_status: "completed",
    trip_driver_id: DRIVER,
    driver_net_pence: 425,
    tip_pence: 100,
    ledger: [{ type: "TRIP_EARNING_NET", amount_pence: 425, driver_id: DRIVER }],
    wallet_evidence_available: true,
    provider_state: "CAPTURED",
    captured_pence: 600,
    captured_at: "2026-01-01T00:00:00Z",
    now_ms: Date.parse("2026-01-10T00:00:00Z"),
  });
  assertEquals(r.expected_driver_credit_pence, 525);
  assertEquals(r.actual_driver_credit_pence, 425);
  assertEquals(r.credit_difference_pence, -100);
  assertEquals(r.health, DRIVER_CREDIT_HEALTH.UNDER_CREDITED);
});

Deno.test("F2: bonus cannot hide tip shortfall", () => {
  const r = classifyDriverCreditHealth({
    financial_model: "PLATFORM_COLLECTED",
    trip_status: "completed",
    trip_driver_id: DRIVER,
    driver_net_pence: 425,
    tip_pence: 100,
    ledger: [
      { type: "TRIP_EARNING_NET", amount_pence: 425, driver_id: DRIVER },
      { type: "BONUS_CREDIT", amount_pence: 100, driver_id: DRIVER },
    ],
    wallet_evidence_available: true,
    provider_state: "CAPTURED",
    captured_pence: 600,
    captured_at: "2026-01-01T00:00:00Z",
    now_ms: Date.parse("2026-01-10T00:00:00Z"),
  });
  assertEquals(r.actual_driver_credit_pence, 425);
  assertEquals(r.credit_difference_pence, -100);
  assertEquals(r.health, DRIVER_CREDIT_HEALTH.UNDER_CREDITED);
});

Deno.test("F2: missing diagnostic only when health is MISSING", () => {
  const ok = buildMissingLedgerDiagnosticRow({
    trip_id: "t1",
    expected_driver_credit_pence: 525,
    driver_credit_health: DRIVER_CREDIT_HEALTH.OK,
  });
  assertEquals(ok, null);

  const missing = buildMissingLedgerDiagnosticRow({
    trip_id: "t1",
    expected_driver_credit_pence: 525,
    driver_credit_health: DRIVER_CREDIT_HEALTH.MISSING,
  });
  assertExists(missing);
  assertEquals(missing!.is_diagnostic_projection, true);
});

Deno.test("F2: TEN + DRIVER_TIP_CREDIT recognised by payment-session credit fields", () => {
  const fields = buildPaymentSessionDriverCreditFields({
    financial_model: "PLATFORM_COLLECTED",
    trip_status: "completed",
    trip_driver_id: DRIVER,
    driver_net_pence: 425,
    tip_pence: 100,
    ledger: tipLedger("t1", 425, 100),
    wallet_evidence_available: true,
    provider_state: "CAPTURED",
    captured_pence: 600,
    captured_at: "2026-01-01T00:00:00Z",
    now_ms: Date.parse("2026-01-10T00:00:00Z"),
  });
  assertEquals(fields.driver_credit_health, DRIVER_CREDIT_HEALTH.OK);
  assertEquals(fields.expected_driver_credit_pence, 525);
  assertEquals(fields.actual_driver_credit_pence, 525);
  assertEquals(fields.credit_difference_pence, 0);
});

Deno.test("F2: DRIVER_COLLECTED isolation — credit N/A", () => {
  const r = classifyDriverCreditHealth({
    financial_model: "DRIVER_COLLECTED_COMMISSION_WALLET",
    trip_status: "completed",
    trip_driver_id: DRIVER,
    driver_net_pence: 900,
    tip_pence: 100,
    ledger: tipLedger("t1", 900, 100),
    wallet_evidence_available: true,
  });
  assertEquals(r.health, DRIVER_CREDIT_HEALTH.NOT_APPLICABLE);
  assertEquals(r.expected_driver_credit_pence, 0);
});

Deno.test("F3: computeNextWeeklyPayoutRun resolves via payoutScheduleSSOT and perDriver re-export", () => {
  const a = computeNextWeeklyPayoutRun({
    weeklyPayoutDay: "monday",
    timeZone: "Europe/London",
    localProcessingTime: "12:00",
  });
  const b = computeNextFromPerDriver({
    weeklyPayoutDay: "monday",
    timeZone: "Europe/London",
    localProcessingTime: "12:00",
  });
  assertExists(a.next_run_at_utc);
  assertEquals(a.next_run_at_utc, b.next_run_at_utc);
  assertEquals(typeof computeNextFromPerDriver, "function");
});

Deno.test("computeExpectedDriverCreditPence is component sum", () => {
  assertEquals(computeExpectedDriverCreditPence({ driver_net_pence: 425, tip_pence: 100 }), 525);
  assertEquals(computeExpectedDriverCreditPence({ driver_net_pence: 525, tip_pence: 100 }), 625);
});
