import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  getTripAvailablePayoutCreatedPence,
  getTripCapturedPenceForAudit,
  getTripDebtRecoveredPence,
  getTripDriverNetPence,
  getTripSettlementFarePence,
} from "./tripSettlementFinanceSSOT.ts";

Deno.test("getTripSettlementFarePence: card captured prefers payment captured over legacy gross", () => {
  const fare = getTripSettlementFarePence(
    {
      payment_method: "card",
      payment_status: "captured",
      gross_fare_pence: 480,
      final_fare_pence: 512,
      capture_amount_pence: 480,
    },
    { paymentCapturedPence: 512 },
  );
  assertEquals(fare, 512);
});

Deno.test("getTripDriverNetPence: never derives fare − commission", () => {
  const net = getTripDriverNetPence({
    driver_net_pence: null,
    ledger: [],
  });
  assertEquals(net, null);
});

Deno.test("getTripCapturedPenceForAudit: payments primary", () => {
  assertEquals(
    getTripCapturedPenceForAudit({ paymentCapturedPence: 512, tripCaptureAmountPence: 480 }),
    512,
  );
});

Deno.test("getTripDebtRecoveredPence: sums DEBT_RECOVERY abs amounts", () => {
  assertEquals(
    getTripDebtRecoveredPence([
      { type: "TRIP_EARNING_NET", amount_pence: 1150 },
      { type: "DEBT_RECOVERY", amount_pence: -75 },
    ]),
    75,
  );
});

Deno.test("getTripAvailablePayoutCreatedPence: driver net minus debt recovered", () => {
  assertEquals(
    getTripAvailablePayoutCreatedPence({ driverNetPence: 1150, debtRecoveredPence: 75 }),
    1075,
  );
  assertEquals(
    getTripAvailablePayoutCreatedPence({ driverNetPence: 500, debtRecoveredPence: 500 }),
    0,
  );
});
