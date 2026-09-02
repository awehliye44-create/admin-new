import { describe, expect, it } from "vitest";
import {
  classifyDriverCreditHealth,
  DEFAULT_PAYOUT_CLEARING_DELAY_HOURS,
  DRIVER_CREDIT_HEALTH,
  DRIVER_CREDIT_EXCEPTION_SCOPE,
  DRIVER_CREDIT_PROCESSING_GRACE_MS,
  DRIVER_CREDIT_RECOMMENDED_OWNER,
  PAYOUT_CREDIT_INTEGRITY,
  aggregateDriverCreditExceptions,
  buildDriverWalletCreditAuditFromSettlementRows,
  classifyPayoutCreditIntegrity,
  computeExpectedDriverCreditPence,
  evaluatePromotionReconciliationIdentity,
  runDriverCreditHistoricalAudit,
} from "../../shared/driverCreditMonitoringSSOT.ts";

const NOW = Date.parse("2026-09-01T12:00:00.000Z");
const OLD_CAPTURE = new Date(NOW - DRIVER_CREDIT_PROCESSING_GRACE_MS - 60_000).toISOString();
const RECENT_CAPTURE = new Date(NOW - 60_000).toISOString();
const NO_SHOW_OLD = new Date(
  NOW - (DEFAULT_PAYOUT_CLEARING_DELAY_HOURS + 1) * 60 * 60 * 1000,
).toISOString();
const NO_SHOW_RECENT = new Date(NOW - 60 * 60 * 1000).toISOString();

describe("driverCreditMonitoringSSOT", () => {
  it("captured trip with exact wallet credit => OK", () => {
    const result = classifyDriverCreditHealth({
      financial_model: "PLATFORM_COLLECTED",
      trip_status: "completed",
      trip_driver_id: "driver-1",
      driver_net_pence: 800,
      tip_pence: 100,
      ledger: [{ type: "TRIP_EARNING_NET", amount_pence: 800, driver_id: "driver-1" }, {
        type: "DRIVER_TIP_CREDIT",
        amount_pence: 100,
        driver_id: "driver-1",
      }],
      wallet_evidence_available: true,
      provider_state: "CAPTURED",
      captured_pence: 1200,
      captured_at: OLD_CAPTURE,
      now_ms: NOW,
    });
    expect(result.health).toBe(DRIVER_CREDIT_HEALTH.OK);
    expect(result.expected_driver_credit_pence).toBe(900);
    expect(result.actual_driver_credit_pence).toBe(900);
    expect(result.credit_difference_pence).toBe(0);
  });

  it("captured trip with no wallet entry => MISSING", () => {
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
    expect(result.health).toBe(DRIVER_CREDIT_HEALTH.MISSING);
    expect(result.actual_driver_credit_pence).toBe(0);
    expect(result.credit_difference_pence).toBe(-425);
  });

  it("partial credit => UNDER_CREDITED", () => {
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
    expect(result.health).toBe(DRIVER_CREDIT_HEALTH.UNDER_CREDITED);
  });

  it("duplicate credit => DUPLICATE", () => {
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
    expect(result.health).toBe(DRIVER_CREDIT_HEALTH.DUPLICATE);
  });

  it("wrong-driver credit => WRONG_DRIVER", () => {
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
    expect(result.health).toBe(DRIVER_CREDIT_HEALTH.WRONG_DRIVER);
  });

  it("provider pending => PENDING, not false MISSING", () => {
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
    expect(result.health).toBe(DRIVER_CREDIT_HEALTH.PENDING);
  });

  it("no-show before 27 hours => PENDING", () => {
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
    expect(result.health).toBe(DRIVER_CREDIT_HEALTH.PENDING);
  });

  it("eligible no-show after 27 hours without credit => MISSING", () => {
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
    expect(result.health).toBe(DRIVER_CREDIT_HEALTH.MISSING);
  });

  it("promotion does not reduce driver earning", () => {
    expect(computeExpectedDriverCreditPence({
      driver_net_pence: 850,
      tip_pence: 0,
    })).toBe(850);
  });

  it("PROMOTION_SUBSIDY clears the promotion reconciliation mismatch", () => {
    const identity = evaluatePromotionReconciliationIdentity({
      captured_pence: 900,
      driver_net_pence: 850,
      commission_pence: 150,
      airport_fee_pence: 0,
      tip_pence: 0,
      platform_promotion_subsidy_pence: 100,
    });
    expect(identity.balanced).toBe(true);
    expect(identity.variance_pence).toBe(0);
  });

  it("payout never pays from FR directly — missing wallet entry blocks payout", () => {
    expect(classifyPayoutCreditIntegrity({
      wallet_ledger_entry_id: null,
      payout_status: "scheduled",
      driver_credit_health: DRIVER_CREDIT_HEALTH.MISSING,
    })).toBe(PAYOUT_CREDIT_INTEGRITY.CREDIT_EXCEPTION);
  });

  it("duplicate credit holds payout for review", () => {
    expect(classifyPayoutCreditIntegrity({
      wallet_ledger_entry_id: "ledger-1",
      payout_status: "scheduled",
      driver_credit_health: DRIVER_CREDIT_HEALTH.DUPLICATE,
    })).toBe(PAYOUT_CREDIT_INTEGRITY.CREDIT_EXCEPTION);
  });

  it("Commission Wallet data remains absent — DRIVER_COLLECTED excluded", () => {
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
    expect(result.health).toBe(DRIVER_CREDIT_HEALTH.NOT_APPLICABLE);
  });

  it("historical audit aggregates eligible and exception trips", () => {
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
      {
        trip_code: "CW-001",
        financial_model: "DRIVER_COLLECTED_COMMISSION_WALLET",
        driver_credit_health: DRIVER_CREDIT_HEALTH.NOT_APPLICABLE,
      },
    ]);
    expect(report.eligible_trips).toBe(2);
    expect(report.correctly_credited_trips).toBe(1);
    expect(report.missing_count).toBe(1);
    expect(report.total_difference_pence).toBe(425);
    expect(report.affected_trip_codes).toEqual(["MK-MISS-002"]);
  });

  it("banner aggregation counts exception trips and difference", () => {
    const agg = aggregateDriverCreditExceptions([
      { driver_credit_health: DRIVER_CREDIT_HEALTH.OK, credit_difference_pence: 0 },
      { driver_credit_health: DRIVER_CREDIT_HEALTH.MISSING, credit_difference_pence: -100 },
      { driver_credit_health: DRIVER_CREDIT_HEALTH.UNDER_CREDITED, credit_difference_pence: -50 },
    ]);
    expect(agg.exception_trip_count).toBe(2);
    expect(agg.total_difference_pence).toBe(150);
  });

  it("scopes driver wallet audit — active vs historical; no scary aggregate on backlog", () => {
    const audit = buildDriverWalletCreditAuditFromSettlementRows([
      {
        trip_code: "MK-ACTIVE-1",
        driver_credit_health: DRIVER_CREDIT_HEALTH.MISSING,
        expected_driver_credit_pence: 376,
        actual_driver_credit_pence: 0,
        credit_difference_pence: -376,
        credit_eligibility_at: new Date(NOW - 60_000).toISOString(),
        settlement_status: "settled",
        completed_at: OLD_CAPTURE,
      },
      {
        trip_code: "MK-HIST-1",
        driver_credit_health: DRIVER_CREDIT_HEALTH.UNDER_CREDITED,
        expected_driver_credit_pence: 500,
        actual_driver_credit_pence: 400,
        credit_difference_pence: -100,
        credit_eligibility_at: new Date(NOW - 60_000).toISOString(),
        settlement_status: "settled",
        completed_at: OLD_CAPTURE,
        payout_status: "paid",
      },
      {
        trip_code: "MK-DUP-1",
        driver_credit_health: DRIVER_CREDIT_HEALTH.DUPLICATE,
        expected_driver_credit_pence: 400,
        actual_driver_credit_pence: 800,
        credit_difference_pence: 400,
        credit_eligibility_at: new Date(NOW - 60_000).toISOString(),
        settlement_status: "settled",
        completed_at: OLD_CAPTURE,
        payout_status: "paid",
      },
    ], { now_ms: NOW });

    expect(audit.summary.active_wallet_impacting_count).toBe(2);
    expect(audit.summary.resolved_paid_count).toBe(1);
    expect(audit.summary.historical_backlog_count).toBe(0);
    expect(audit.summary.show_blocking_alert).toBe(true);
    expect(audit.summary.active_balance_variance_pence).toBe(776);
    expect(
      audit.rows.find((r) => r.trip_code === "MK-ACTIVE-1")?.recommended_owner,
    ).toBe(DRIVER_CREDIT_RECOMMENDED_OWNER.SETTLEMENT_REPAIR);
    expect(
      audit.rows.find((r) => r.trip_code === "MK-HIST-1")?.scope,
    ).toBe(DRIVER_CREDIT_EXCEPTION_SCOPE.RESOLVED_PAID_HISTORY);
    expect(
      audit.rows.find((r) => r.trip_code === "MK-DUP-1")?.scope,
    ).toBe(DRIVER_CREDIT_EXCEPTION_SCOPE.ACTIVE_WALLET_IMPACTING);
  });
});
