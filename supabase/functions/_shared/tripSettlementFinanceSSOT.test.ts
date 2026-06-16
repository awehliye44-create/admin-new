import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  getTripCapturedPenceForAudit,
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
