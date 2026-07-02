import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  computeCardCaptureRecoveryTransfer,
  computeDriverStripeTransferAmountPence,
  computeRemainingRecoveryDebtPence,
} from "./cardCaptureRecoveryTransferSSOT.ts";

Deno.test("A) driver_net £4.08, debt £9.01 → transfer £0.00, remaining debt £4.93", () => {
  assertEquals(
    computeDriverStripeTransferAmountPence({
      driverNetPence: 408,
      outstandingRecoveryDebtPence: 901,
    }),
    0,
  );
  assertEquals(
    computeRemainingRecoveryDebtPence({
      outstandingRecoveryDebtPence: 901,
      driverNetPence: 408,
    }),
    493,
  );
});

Deno.test("B) driver_net £10.00, debt £3.00 → transfer £7.00, remaining debt £0.00", () => {
  const result = computeCardCaptureRecoveryTransfer({
    finalFarePence: 1200,
    commissionPence: 200,
    outstandingRecoveryDebtPence: 300,
  });
  assertEquals(result.driver_net_pence, 1000);
  assertEquals(result.driver_stripe_transfer_net_pence, 700);
  assertEquals(result.remaining_recovery_debt_pence, 0);
  assertEquals(result.debt_recovery_pence, 300);
});
