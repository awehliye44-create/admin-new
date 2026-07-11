import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildDriverWalletSettlementHistoryRow } from "./driverWalletSettlementHistorySSOT.ts";

Deno.test("settlement history: customer paid from Payment Sessions only", () => {
  const row = buildDriverWalletSettlementHistoryRow({
    settlement_id: "s1",
    trip_id: "t1",
    settlement_status: "settled",
    settled_at: "2026-07-01T12:00:00Z",
    wallet_credit_pence: 408,
    trip: {
      trip_code: "MK-1",
      completed_at: "2026-07-01T11:00:00Z",
      passenger_name: "Alex",
      payment_provider: "revolut",
      payment_method: "card",
      provider_fee_pence: 25,
      platform_commission_amount: 72,
      driver_tier_commission_percent: 15,
      driver_net_pence: 408,
      payment_session_id: "ps-legacy",
    },
    payment_session: {
      id: "ps-1",
      payment_provider: "revolut",
      payment_method: "card",
      captured_amount_pence: 480,
      provider_processing_fee_pence: 25,
    },
  });

  assertEquals(row.customer_paid_pence, 480);
  assertEquals(row.provider_fee_pence, 25);
  assertEquals(row.platform_commission_pence, 72);
  assertEquals(row.driver_commission_percent, 15);
  assertEquals(row.driver_net_pence, 408);
  assertEquals(row.wallet_credit_pence, 408);
  assertEquals(row.payment_session_id, "ps-1");
});

Deno.test("settlement history: cash has null customer paid (no PS capture invent)", () => {
  const row = buildDriverWalletSettlementHistoryRow({
    settlement_id: "s2",
    trip_id: "t2",
    settlement_status: "settled",
    settled_at: null,
    wallet_credit_pence: 500,
    trip: {
      passenger_name: "Sam",
      payment_method: "cash",
      driver_net_pence: 500,
      platform_commission_amount: 88,
      driver_tier_commission_percent: 15,
    },
    payment_session: null,
  });

  assertEquals(row.customer_paid_pence, null);
  assertEquals(row.payment_method, "cash");
  assertEquals(row.wallet_credit_pence, 500);
});
