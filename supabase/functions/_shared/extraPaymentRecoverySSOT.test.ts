import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  assertExtraPaymentAmountTrusted,
  computeSettlementTotalPence,
  resolveExtraPaymentChargePence,
} from "./extraPaymentRecoverySSOT.ts";

Deno.test("MK-260624-001 — settlement 849p captured 400p outstanding 449p", () => {
  const settlement = computeSettlementTotalPence({ final_fare_pence: 849 });
  assertEquals(settlement, 849);

  const resolution = resolveExtraPaymentChargePence({
    trip: { final_fare_pence: 849, outstanding_balance_pence: 449 },
    payments: [{ captured_amount_pence: 400, status: "captured" }],
  });

  assertEquals(resolution.settlement_total_pence, 849);
  assertEquals(resolution.captured_total_pence, 400);
  assertEquals(resolution.charge_pence, 449);
  assertEquals(resolution.source, "trip_outstanding_ssot");
});

Deno.test("rejects untrusted UI amount", () => {
  const err = assertExtraPaymentAmountTrusted(500, 449);
  assertEquals(err?.includes("does not match"), true);
});

Deno.test("blocks second recovery when nothing outstanding", () => {
  const resolution = resolveExtraPaymentChargePence({
    trip: { final_fare_pence: 849, outstanding_balance_pence: 0 },
    payments: [
      { captured_amount_pence: 400, status: "captured" },
      { captured_amount_pence: 449, status: "captured" },
    ],
  });
  assertEquals(resolution.charge_pence, 0);
});
