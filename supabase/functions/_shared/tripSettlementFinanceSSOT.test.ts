import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildTripCardRecoveryPaymentState,
  computeNetPayableAfterRecoveryPence,
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

Deno.test("getTripAvailablePayoutCreatedPence: driver net minus debt recovered (SSOT)", () => {
  assertEquals(
    getTripAvailablePayoutCreatedPence({ driverNetPence: 1150, debtRecoveredPence: 75 }),
    1075,
  );
  assertEquals(
    getTripAvailablePayoutCreatedPence({ driverNetPence: 500, debtRecoveredPence: 500 }),
    0,
  );
  assertEquals(
    getTripAvailablePayoutCreatedPence({ driverNetPence: 408, debtRecoveredPence: 408 }),
    0,
  );
  assertEquals(
    getTripAvailablePayoutCreatedPence({ driverNetPence: 1000, debtRecoveredPence: 300 }),
    700,
  );
});

Deno.test("buildTripCardRecoveryPaymentState B) driver net £4.08, debt £9.01", () => {
  const state = buildTripCardRecoveryPaymentState({
    driverNetPence: 408,
    tripDebtRecoveryPence: 408,
    tripStripeTransferAmountPence: 0,
    captureDebtRecoveryPence: 408,
    captureRemainingRecoveryDebtPence: 493,
  });
  assertEquals(state.stripe_transfer_amount_pence, 0);
  assertEquals(state.debt_recovered_pence, 408);
  assertEquals(state.remaining_recovery_debt_pence, 493);
  assertEquals(state.outstanding_recovery_debt_pence, 901);
  assertEquals(state.available_payout_created_pence, 0);
});

Deno.test("buildTripCardRecoveryPaymentState C) driver net £10.00, debt £3.00", () => {
  const state = buildTripCardRecoveryPaymentState({
    driverNetPence: 1000,
    tripDebtRecoveryPence: 300,
    tripStripeTransferAmountPence: 700,
    captureDebtRecoveryPence: 300,
    captureRemainingRecoveryDebtPence: 0,
  });
  assertEquals(state.stripe_transfer_amount_pence, 700);
  assertEquals(state.debt_recovered_pence, 300);
  assertEquals(state.remaining_recovery_debt_pence, 0);
  assertEquals(state.outstanding_recovery_debt_pence, 300);
  assertEquals(state.available_payout_created_pence, 700);
});

Deno.test("computeNetPayableAfterRecoveryPence A) liability £9.01, recovery £9.01", () => {
  assertEquals(computeNetPayableAfterRecoveryPence(901, 901), 0);
});
