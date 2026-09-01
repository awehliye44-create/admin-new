import { describe, expect, it } from "vitest";
import {
  classifyDriverCreditHealth,
  DRIVER_CREDIT_HEALTH,
  classifyPayoutCreditIntegrity,
  PAYOUT_CREDIT_INTEGRITY,
} from "../driverCreditMonitoringSSOT.ts";

/**
 * Lock: driver credit monitoring stays PLATFORM_COLLECTED-only across all four layers.
 * Commission Wallet / DRIVER_COLLECTED must never surface as monitorable driver credit debt.
 */
describe("driver credit monitoring four-layer isolation lock", () => {
  it("Payment Sessions layer: DRIVER_COLLECTED => NOT_APPLICABLE display path", () => {
    const credit = classifyDriverCreditHealth({
      financial_model: "DRIVER_COLLECTED_COMMISSION_WALLET",
      trip_status: "completed",
      trip_driver_id: "d1",
      driver_net_pence: 500,
      ledger: [{ type: "TRIP_EARNING_NET", amount_pence: 500, driver_id: "d1" }],
      wallet_evidence_available: true,
      provider_state: "CAPTURED",
      captured_pence: 600,
      captured_at: "2026-08-01T10:00:00.000Z",
      now_ms: Date.parse("2026-09-01T12:00:00.000Z"),
    });
    expect(credit.health).toBe(DRIVER_CREDIT_HEALTH.NOT_APPLICABLE);
    expect(credit.expected_driver_credit_pence).toBe(0);
  });

  it("Financial Reconciliation layer: promotion does not reduce expected driver credit", () => {
    const credit = classifyDriverCreditHealth({
      financial_model: "PLATFORM_COLLECTED",
      trip_status: "completed",
      trip_driver_id: "d1",
      driver_net_pence: 850,
      tip_pence: 0,
      ledger: [{ type: "TRIP_EARNING_NET", amount_pence: 850, driver_id: "d1" }],
      wallet_evidence_available: true,
      provider_state: "CAPTURED",
      captured_pence: 900,
      captured_at: "2026-08-01T10:00:00.000Z",
      now_ms: Date.parse("2026-09-01T12:00:00.000Z"),
    });
    expect(credit.health).toBe(DRIVER_CREDIT_HEALTH.OK);
    expect(credit.expected_driver_credit_pence).toBe(850);
  });

  it("Driver Wallet layer: missing credit is MISSING not auto-repaired", () => {
    const credit = classifyDriverCreditHealth({
      financial_model: "PLATFORM_COLLECTED",
      trip_status: "completed",
      trip_driver_id: "d1",
      driver_net_pence: 425,
      ledger: [],
      wallet_evidence_available: true,
      provider_state: "CAPTURED",
      captured_pence: 500,
      captured_at: "2026-08-01T10:00:00.000Z",
      now_ms: Date.parse("2026-09-01T12:00:00.000Z"),
    });
    expect(credit.health).toBe(DRIVER_CREDIT_HEALTH.MISSING);
    expect(credit.actual_driver_credit_pence).toBe(0);
  });

  it("Payout Ledger layer: never payout-ready without wallet ledger entry", () => {
    expect(classifyPayoutCreditIntegrity({
      wallet_ledger_entry_id: null,
      payout_status: "scheduled",
      driver_credit_health: DRIVER_CREDIT_HEALTH.MISSING,
    })).toBe(PAYOUT_CREDIT_INTEGRITY.CREDIT_EXCEPTION);

    expect(classifyPayoutCreditIntegrity({
      wallet_ledger_entry_id: "ledger-entry-1",
      payout_status: "scheduled",
      driver_credit_health: DRIVER_CREDIT_HEALTH.OK,
    })).toBe(PAYOUT_CREDIT_INTEGRITY.WALLET_CREDIT_VERIFIED);
  });
});
