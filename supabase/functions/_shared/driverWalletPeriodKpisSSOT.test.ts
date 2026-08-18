/**
 * Deno tests for driver wallet period KPIs (backend SSOT).
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildDriverWalletPeriodKpis } from "./driverWalletPeriodKpisSSOT.ts";

Deno.test("buildDriverWalletPeriodKpis — commission + last periods + provider fees null", () => {
  const now = new Date("2026-07-10T12:00:00Z");
  const kpis = buildDriverWalletPeriodKpis(
    [
      {
        type: "TRIP_EARNING_NET",
        amount_pence: 1000,
        created_at: "2026-07-10T10:00:00Z",
        economic_earned_at: "2026-07-10T10:00:00Z",
        related_trip_id: "t1",
      },
      {
        type: "PLATFORM_COMMISSION",
        amount_pence: -150,
        created_at: "2026-07-10T10:00:00Z",
        related_trip_id: "t1",
      },
      {
        type: "TRIP_EARNING_NET",
        amount_pence: 500,
        created_at: "2026-06-15T10:00:00Z",
        economic_earned_at: "2026-06-15T10:00:00Z",
        related_trip_id: "t2",
      },
    ],
    { recoveryDebtPence: 25, pendingEarningsPence: 200, now },
  );

  assertEquals(kpis.today_earnings_pence, 1000);
  assertEquals(kpis.lifetime_earnings_pence, 1500);
  assertEquals(kpis.platform_commission_pence, 150);
  assertEquals(kpis.provider_fees_reference_pence, null);
  assertEquals(kpis.outstanding_debt_pence, 25);
  assertEquals(kpis.pending_earnings_pence, 200);
  assertEquals(kpis.trips_paid_count, 2);
  assertEquals(kpis.timezone, "Europe/London");
});

Deno.test("buildDriverWalletPeriodKpis — late TEN recovery attributes to capture day", () => {
  const now = new Date("2026-08-18T16:00:00Z");
  const kpis = buildDriverWalletPeriodKpis(
    [
      {
        type: "TRIP_EARNING_NET",
        amount_pence: 637,
        created_at: "2026-08-17T11:44:02.234Z",
        economic_earned_at: "2026-08-17T08:42:50.690Z",
        related_trip_id: "mk005",
      },
      {
        type: "TRIP_EARNING_NET",
        amount_pence: 425,
        created_at: "2026-08-18T15:00:00.000Z",
        economic_earned_at: "2026-08-17T18:50:46.198Z",
        related_trip_id: "mk007",
      },
      {
        type: "TRIP_EARNING_NET",
        amount_pence: 706,
        created_at: "2026-08-18T15:00:01.000Z",
        economic_earned_at: "2026-08-17T19:27:16.212Z",
        related_trip_id: "mk009",
      },
    ],
    { now },
  );
  assertEquals(kpis.today_earnings_pence, 0);
  assertEquals(kpis.lifetime_earnings_pence, 1768);
});
