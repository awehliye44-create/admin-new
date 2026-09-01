import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  classifyDriverCreditHealth,
  classifyPayoutCreditIntegrity,
  computeExpectedDriverCreditPence,
  DEFAULT_PAYOUT_CLEARING_DELAY_HOURS,
  DRIVER_CREDIT_HEALTH,
  DRIVER_CREDIT_PROCESSING_GRACE_MS,
  PAYOUT_CREDIT_INTEGRITY,
  evaluatePromotionReconciliationIdentity,
  runDriverCreditHistoricalAudit,
  mapDriverCreditHealthToWalletReconciliationStatus,
  buildMissingLedgerDiagnosticRow,
  isDriverCreditExceptionHealth,
} from "./driverCreditMonitoringSSOT.ts";

const NOW = Date.parse("2026-09-01T12:00:00.000Z");
const OLD_CAPTURE = new Date(NOW - DRIVER_CREDIT_PROCESSING_GRACE_MS - 60_000).toISOString();
const NO_SHOW_OLD = new Date(
  NOW - (DEFAULT_PAYOUT_CLEARING_DELAY_HOURS + 1) * 60 * 60 * 1000,
).toISOString();
const NO_SHOW_RECENT = new Date(NOW - 60 * 60 * 1000).toISOString();

Deno.test("captured trip with exact wallet credit => OK", () => {
  const result = classifyDriverCreditHealth({
    financial_model: "PLATFORM_COLLECTED",
    trip_status: "completed",
    trip_driver_id: "driver-1",
    driver_net_pence: 800,
    tip_pence: 100,
    ledger: [
      { type: "TRIP_EARNING_NET", amount_pence: 800, driver_id: "driver-1" },
      { type: "DRIVER_TIP_CREDIT", amount_pence: 100, driver_id: "driver-1" },
    ],
    wallet_evidence_available: true,
    provider_state: "CAPTURED",
    captured_pence: 1200,
    captured_at: OLD_CAPTURE,
    now_ms: NOW,
  });
  assertEquals(result.health, DRIVER_CREDIT_HEALTH.OK);
});

Deno.test("captured trip with no wallet entry => MISSING", () => {
  const result = classifyDriverCreditHealth({
    financial_model: "PLATFORM_COLLECTED",
    trip_status: "completed",
    trip_driver_id: "driver-1",
    driver_net_pence: 425,
    ledger: [],
    wallet_evidence_available: true,
    provider_state: "CAPTURED",
    captured_pence: 500,
    captured_at: OLD_CAPTURE,
    now_ms: NOW,
  });
  assertEquals(result.health, DRIVER_CREDIT_HEALTH.MISSING);
});

Deno.test("partial credit => UNDER_CREDITED", () => {
  const result = classifyDriverCreditHealth({
    financial_model: "PLATFORM_COLLECTED",
    trip_status: "completed",
    trip_driver_id: "driver-1",
    driver_net_pence: 500,
    ledger: [{ type: "TRIP_EARNING_NET", amount_pence: 300, driver_id: "driver-1" }],
    wallet_evidence_available: true,
    provider_state: "CAPTURED",
    captured_pence: 600,
    captured_at: OLD_CAPTURE,
    now_ms: NOW,
  });
  assertEquals(result.health, DRIVER_CREDIT_HEALTH.UNDER_CREDITED);
});

Deno.test("duplicate credit => DUPLICATE", () => {
  const result = classifyDriverCreditHealth({
    financial_model: "PLATFORM_COLLECTED",
    trip_status: "completed",
    trip_driver_id: "driver-1",
    driver_net_pence: 400,
    ledger: [
      { type: "TRIP_EARNING_NET", amount_pence: 400, driver_id: "driver-1" },
      { type: "TRIP_EARNING_NET", amount_pence: 400, driver_id: "driver-1" },
    ],
    wallet_evidence_available: true,
    provider_state: "CAPTURED",
    captured_pence: 500,
    captured_at: OLD_CAPTURE,
    now_ms: NOW,
  });
  assertEquals(result.health, DRIVER_CREDIT_HEALTH.DUPLICATE);
});

Deno.test("wrong-driver credit => WRONG_DRIVER", () => {
  const result = classifyDriverCreditHealth({
    financial_model: "PLATFORM_COLLECTED",
    trip_status: "completed",
    trip_driver_id: "driver-1",
    driver_net_pence: 400,
    ledger: [{ type: "TRIP_EARNING_NET", amount_pence: 400, driver_id: "driver-2" }],
    wallet_evidence_available: true,
    provider_state: "CAPTURED",
    captured_pence: 500,
    captured_at: OLD_CAPTURE,
    now_ms: NOW,
  });
  assertEquals(result.health, DRIVER_CREDIT_HEALTH.WRONG_DRIVER);
});

Deno.test("provider pending => PENDING", () => {
  const result = classifyDriverCreditHealth({
    financial_model: "PLATFORM_COLLECTED",
    trip_status: "completed",
    trip_driver_id: "driver-1",
    driver_net_pence: 400,
    ledger: [],
    wallet_evidence_available: true,
    provider_state: "AUTHORISED",
    captured_pence: null,
    now_ms: NOW,
  });
  assertEquals(result.health, DRIVER_CREDIT_HEALTH.PENDING);
});

Deno.test("no-show before 27 hours => PENDING", () => {
  const result = classifyDriverCreditHealth({
    financial_model: "PLATFORM_COLLECTED",
    trip_status: "no_show",
    trip_driver_id: "driver-1",
    driver_net_pence: 800,
    ledger: [],
    wallet_evidence_available: true,
    provider_state: "CAPTURED",
    captured_pence: 800,
    captured_at: NO_SHOW_RECENT,
    fee_charged_at: NO_SHOW_RECENT,
    is_terminal_fee_session: true,
    now_ms: NOW,
  });
  assertEquals(result.health, DRIVER_CREDIT_HEALTH.PENDING);
});

Deno.test("eligible no-show after 27 hours without credit => MISSING", () => {
  const result = classifyDriverCreditHealth({
    financial_model: "PLATFORM_COLLECTED",
    trip_status: "no_show",
    trip_driver_id: "driver-1",
    driver_net_pence: 800,
    ledger: [],
    wallet_evidence_available: true,
    provider_state: "CAPTURED",
    captured_pence: 800,
    captured_at: NO_SHOW_OLD,
    fee_charged_at: NO_SHOW_OLD,
    is_terminal_fee_session: true,
    now_ms: NOW,
  });
  assertEquals(result.health, DRIVER_CREDIT_HEALTH.MISSING);
});

Deno.test("promotion does not reduce driver earning", () => {
  assertEquals(computeExpectedDriverCreditPence({ driver_net_pence: 850 }), 850);
});

Deno.test("PROMOTION_SUBSIDY clears promotion reconciliation mismatch", () => {
  const identity = evaluatePromotionReconciliationIdentity({
    captured_pence: 900,
    driver_net_pence: 850,
    commission_pence: 150,
    platform_promotion_subsidy_pence: 100,
  });
  assertEquals(identity.balanced, true);
});

Deno.test("payout never pays without wallet ledger entry", () => {
  assertEquals(
    classifyPayoutCreditIntegrity({
      wallet_ledger_entry_id: null,
      payout_status: "scheduled",
      driver_credit_health: DRIVER_CREDIT_HEALTH.MISSING,
    }),
    PAYOUT_CREDIT_INTEGRITY.CREDIT_EXCEPTION,
  );
});

Deno.test("duplicate credit holds payout", () => {
  assertEquals(
    classifyPayoutCreditIntegrity({
      wallet_ledger_entry_id: "ledger-1",
      payout_status: "scheduled",
      driver_credit_health: DRIVER_CREDIT_HEALTH.DUPLICATE,
    }),
    PAYOUT_CREDIT_INTEGRITY.CREDIT_EXCEPTION,
  );
});

Deno.test("Commission Wallet / DRIVER_COLLECTED excluded", () => {
  const result = classifyDriverCreditHealth({
    financial_model: "DRIVER_COLLECTED_COMMISSION_WALLET",
    trip_status: "completed",
    trip_driver_id: "driver-1",
    driver_net_pence: 500,
    ledger: [{ type: "TRIP_EARNING_NET", amount_pence: 500, driver_id: "driver-1" }],
    wallet_evidence_available: true,
    provider_state: "CAPTURED",
    captured_pence: 600,
    captured_at: OLD_CAPTURE,
    now_ms: NOW,
  });
  assertEquals(result.health, DRIVER_CREDIT_HEALTH.NOT_APPLICABLE);
});

Deno.test("WRONG_DRIVER maps to WALLET_WRONG_DRIVER reconciliation status", () => {
  assertEquals(
    mapDriverCreditHealthToWalletReconciliationStatus(DRIVER_CREDIT_HEALTH.WRONG_DRIVER),
    "WALLET_WRONG_DRIVER",
  );
});

Deno.test("historical audit report", () => {
  const report = runDriverCreditHistoricalAudit([
    {
      trip_code: "MK-OK-001",
      financial_model: "PLATFORM_COLLECTED",
      driver_credit_health: DRIVER_CREDIT_HEALTH.OK,
      credit_difference_pence: 0,
    },
    {
      trip_code: "MK-MISS-002",
      financial_model: "PLATFORM_COLLECTED",
      driver_credit_health: DRIVER_CREDIT_HEALTH.MISSING,
      credit_difference_pence: -425,
    },
  ]);
  assertEquals(report.eligible_trips, 2);
  assertEquals(report.missing_count, 1);
  assertEquals(report.affected_trip_codes, ["MK-MISS-002"]);
});

Deno.test("missing ledger diagnostic row stamps credit difference", () => {
  const row = buildMissingLedgerDiagnosticRow({
    trip_id: "trip-1",
    trip_code: "MK-001",
    expected_driver_credit_pence: 425,
    driver_credit_health: DRIVER_CREDIT_HEALTH.MISSING,
    credit_eligibility_at: OLD_CAPTURE,
    payment_session_id: "ps-1",
  });
  assertEquals(row?.credit_difference_pence, -425);
  assertEquals(row?.actual_driver_credit_pence, 0);
});

Deno.test("payout CREDIT_EXCEPTION label is not a driver credit health exception", () => {
  assertEquals(isDriverCreditExceptionHealth("CREDIT_EXCEPTION"), false);
  assertEquals(isDriverCreditExceptionHealth(DRIVER_CREDIT_HEALTH.UNDER_CREDITED), true);
});
