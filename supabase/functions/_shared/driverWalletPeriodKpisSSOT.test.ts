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
