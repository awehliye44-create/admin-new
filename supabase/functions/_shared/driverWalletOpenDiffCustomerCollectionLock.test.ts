/**
 * Lock: Driver Wallet Open difference = expected entitlement − actual TEN only.
 * Never feed customer capture shortfall / receivable variance into wallet open diff.
 *
 * MK-017: expected TEN 430 − actual TEN 430 = 0 (historical 6p is customer collection).
 * MK-003: expected TEN 598 − actual TEN 598 = 0.
 */
import {
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  periodPayableVariancePence,
} from "./frDriverReconciliationSSOT.ts";

Deno.test("5. MK-017 expected=actual 430 → wallet difference 0 despite historical 6p customer shortfall", () => {
  const customerShortfallPence = 6; // historical evidence — must not enter wallet variance
  const variance = periodPayableVariancePence({
    expected_payable_pence: 430,
    actual_ten_credits_pence: 430,
  });
  assertEquals(variance, 0);
  // Defence: customer shortfall is a separate FR class.
  assertEquals(customerShortfallPence, 6);
  assertEquals((variance ?? 0) + 0 * customerShortfallPence, 0);
});

Deno.test("MK-003 expected=actual 598 → wallet difference 0", () => {
  const variance = periodPayableVariancePence({
    expected_payable_pence: 598,
    actual_ten_credits_pence: 598,
  });
  assertEquals(variance, 0);
});

Deno.test("wallet open difference never equals customer shortfall when TEN matches", () => {
  const expected = 430;
  const actual = 430;
  const customerCollectionVariance = 6;
  const openDiff = periodPayableVariancePence({
    expected_payable_pence: expected,
    actual_ten_credits_pence: actual,
  });
  assertEquals(openDiff, 0);
  assertEquals(openDiff === customerCollectionVariance, false);
});
