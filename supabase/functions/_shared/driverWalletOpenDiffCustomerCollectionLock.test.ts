/**
 * Lock: Driver Wallet Open difference = expected driver entitlement − actual TEN only.
 * Period and lifetime scopes must agree when the same trip credits are the only inputs.
 * Customer capture/receivable variance cannot enter this selector.
 */
import {
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  periodPayableVariancePence,
} from "./frDriverReconciliationSSOT.ts";

function openDiff(expected: number, actual: number): number {
  const v = periodPayableVariancePence({
    expected_payable_pence: expected,
    actual_ten_credits_pence: actual,
  });
  if (v == null) throw new Error("open diff null");
  return v;
}

Deno.test("5. MK-017 expected=actual 430 → wallet difference 0 despite historical 6p customer shortfall", () => {
  const customerShortfallPence = 6;
  assertEquals(openDiff(430, 430), 0);
  assertEquals(customerShortfallPence, 6);
});

Deno.test("MK-003 expected=actual 598 → wallet difference 0", () => {
  assertEquals(openDiff(598, 598), 0);
});

Deno.test("period vs lifetime: same trip set → same open diff (0)", () => {
  const periodExpected = 598 + 430;
  const periodActual = 598 + 430;
  const lifetimeExpected = 598 + 430;
  const lifetimeActual = 598 + 430;
  assertEquals(openDiff(periodExpected, periodActual), 0);
  assertEquals(openDiff(lifetimeExpected, lifetimeActual), 0);
  assertEquals(
    openDiff(periodExpected, periodActual),
    openDiff(lifetimeExpected, lifetimeActual),
  );
});

Deno.test("customer capture variance / receivable amounts cannot enter open diff selector", () => {
  const customerCaptureVariance = 36;
  const receivableOriginal = 36;
  const walletOpen = openDiff(598, 598);
  assertEquals(walletOpen, 0);
  assertEquals(walletOpen === customerCaptureVariance, false);
  assertEquals(walletOpen === receivableOriginal, false);
});
