/**
 * Read-only driver credit historical audit runner.
 *
 * Usage (fixture mode — no DB):
 *   deno run --allow-read scripts/runDriverCreditHistoricalAudit.ts
 *
 * Production use requires separate approval — pass audit rows JSON via stdin:
 *   cat audit-rows.json | deno run --allow-read scripts/runDriverCreditHistoricalAudit.ts --stdin
 */
import {
  classifyDriverCreditHealth,
  runDriverCreditHistoricalAudit,
  type DriverCreditHistoricalAuditReport,
} from "../supabase/functions/_shared/driverCreditMonitoringSSOT.ts";

const FIXTURE_TRIPS = [
  {
    trip_code: "MK-AUDIT-001",
    financial_model: "PLATFORM_COLLECTED",
    trip_status: "completed",
    trip_driver_id: "driver-1",
    driver_net_pence: 500,
    provider_state: "CAPTURED",
    captured_pence: 600,
    captured_at: "2026-08-28T10:00:00.000Z",
    ledger: [{ type: "TRIP_EARNING_NET", amount_pence: 500, driver_id: "driver-1" }],
  },
  {
    trip_code: "MK-AUDIT-002",
    financial_model: "PLATFORM_COLLECTED",
    trip_status: "completed",
    trip_driver_id: "driver-2",
    driver_net_pence: 300,
    provider_state: "CAPTURED",
    captured_pence: 400,
    captured_at: "2026-08-28T10:00:00.000Z",
    ledger: [],
  },
  {
    trip_code: "CW-001",
    financial_model: "DRIVER_COLLECTED_COMMISSION_WALLET",
    trip_status: "completed",
    trip_driver_id: "driver-3",
    driver_net_pence: 200,
    provider_state: "CAPTURED",
    captured_pence: 300,
    captured_at: "2026-08-28T10:00:00.000Z",
    ledger: [{ type: "TRIP_EARNING_NET", amount_pence: 200, driver_id: "driver-3" }],
  },
] as const;

function printReport(report: DriverCreditHistoricalAuditReport): void {
  console.log(JSON.stringify({
    eligible_trips: report.eligible_trips,
    correctly_credited_trips: report.correctly_credited_trips,
    missing_count: report.missing_count,
    under_credited_count: report.under_credited_count,
    over_credited_count: report.over_credited_count,
    duplicate_count: report.duplicate_count,
    wrong_driver_count: report.wrong_driver_count,
    pending_count: report.pending_count,
    not_applicable_count: report.not_applicable_count,
    total_difference_pence: report.total_difference_pence,
    affected_trip_codes: report.affected_trip_codes,
  }, null, 2));
}

function auditFromFixtures(): DriverCreditHistoricalAuditReport {
  const rows = FIXTURE_TRIPS.map((trip) => {
    const credit = classifyDriverCreditHealth({
      financial_model: trip.financial_model,
      trip_status: trip.trip_status,
      trip_driver_id: trip.trip_driver_id,
      driver_net_pence: trip.driver_net_pence,
      ledger: [...trip.ledger],
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

if (import.meta.main) {
  const useStdin = Deno.args.includes("--stdin");
  if (useStdin) {
    const raw = await Deno.readTextFile("/dev/stdin");
    const parsed = JSON.parse(raw) as Array<{
      trip_code?: string | null;
      financial_model?: string | null;
      driver_credit_health?: string | null;
      credit_difference_pence?: number | null;
    }>;
    printReport(runDriverCreditHistoricalAudit(parsed));
  } else {
    printReport(auditFromFixtures());
  }
}
