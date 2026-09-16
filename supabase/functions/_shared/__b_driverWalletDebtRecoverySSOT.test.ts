import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildDriverWalletDebtRecoveryKpis } from "./driverWalletDebtRecoverySSOT.ts";

Deno.test("debt recovery KPIs: outstanding ≠ remaining", () => {
  const kpis = buildDriverWalletDebtRecoveryKpis(
    [
      { type: "CASH_COMMISSION_DEBT", amount_pence: -100 },
      { type: "DEBT_RECOVERY", amount_pence: -40 },
      { type: "TRIP_EARNING_NET", amount_pence: 500 },
    ],
    60,
  );
  assertEquals(kpis.outstanding_debt_pence, 100);
  assertEquals(kpis.recovered_amount_pence, 40);
  assertEquals(kpis.remaining_debt_pence, 60);
  assertEquals(kpis.recovery_percent, 40);
});

Deno.test("debt recovery KPIs: zero when no debt", () => {
  const kpis = buildDriverWalletDebtRecoveryKpis(
    [{ type: "TRIP_EARNING_NET", amount_pence: 500 }],
    0,
  );
  assertEquals(kpis.outstanding_debt_pence, 0);
  assertEquals(kpis.recovered_amount_pence, 0);
  assertEquals(kpis.remaining_debt_pence, 0);
  assertEquals(kpis.recovery_percent, null);
});
