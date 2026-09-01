/**
 * Read-only historical driver credit audit across PLATFORM_COLLECTED trips.
 * Does not write wallet entries, call Revolut, or modify payouts.
 *
 * Run: npx vitest run shared/__tests__/driverCreditHistoricalAudit.test.ts
 */
import { describe, expect, it } from "vitest";
import {
  classifyDriverCreditHealth,
  runDriverCreditHistoricalAudit,
} from "../driverCreditMonitoringSSOT.ts";

type PlatformCollectedTripFixture = {
  trip_id: string;
  trip_code: string;
  financial_model: string;
  trip_status: string;
  trip_driver_id: string;
  driver_net_pence: number;
  tip_pence?: number;
  provider_state: string;
  captured_pence: number;
  captured_at: string;
  ledger: Array<{ type: string; amount_pence: number; driver_id: string }>;
};

function auditTrips(trips: PlatformCollectedTripFixture[]) {
  const rows = trips.map((trip) => {
    const credit = classifyDriverCreditHealth({
      financial_model: trip.financial_model,
      trip_status: trip.trip_status,
      trip_driver_id: trip.trip_driver_id,
      driver_net_pence: trip.driver_net_pence,
      tip_pence: trip.tip_pence ?? 0,
      ledger: trip.ledger,
      wallet_evidence_available: true,
      provider_state: trip.provider_state,
      captured_pence: trip.captured_pence,
      captured_at: trip.captured_at,
      now_ms: Date.parse("2026-09-01T12:00:00.000Z"),
    });
    return {
      trip_code: trip.trip_code,
      financial_model: trip.financial_model,
      driver_credit_health: credit.health,
      credit_difference_pence: credit.credit_difference_pence,
    };
  });
  return runDriverCreditHistoricalAudit(rows);
}

describe("driver credit historical audit (read-only)", () => {
  it("reports eligible, correct, missing and affected trip codes", () => {
    const oldCapture = "2026-08-28T10:00:00.000Z";
    const report = auditTrips([
      {
        trip_id: "1",
        trip_code: "MK-AUDIT-001",
        financial_model: "PLATFORM_COLLECTED",
        trip_status: "completed",
        trip_driver_id: "d1",
        driver_net_pence: 500,
        provider_state: "CAPTURED",
        captured_pence: 600,
        captured_at: oldCapture,
        ledger: [{ type: "TRIP_EARNING_NET", amount_pence: 500, driver_id: "d1" }],
      },
      {
        trip_id: "2",
        trip_code: "MK-AUDIT-002",
        financial_model: "PLATFORM_COLLECTED",
        trip_status: "completed",
        trip_driver_id: "d2",
        driver_net_pence: 300,
        provider_state: "CAPTURED",
        captured_pence: 400,
        captured_at: oldCapture,
        ledger: [],
      },
    ]);

    console.log("[driver-credit-historical-audit]", JSON.stringify(report, null, 2));

    expect(report.eligible_trips).toBe(2);
    expect(report.correctly_credited_trips).toBe(1);
    expect(report.missing_count).toBe(1);
    expect(report.affected_trip_codes).toContain("MK-AUDIT-002");
    expect(report.total_difference_pence).toBeGreaterThan(0);
  });
});
