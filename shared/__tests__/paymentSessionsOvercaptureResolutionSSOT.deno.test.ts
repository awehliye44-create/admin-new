/**
 * Run: deno test --allow-read shared/__tests__/paymentSessionsOvercaptureResolutionSSOT.deno.test.ts
 */
import {
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  resolveOvercaptureCustomerPosition,
  sumOvercaptureResolutionTotals,
} from "../paymentSessionsOvercaptureResolutionSSOT.ts";

Deno.test("MK-260719-006: gross 253 fully refunded → outstanding 0", () => {
  const r = resolveOvercaptureCustomerPosition({
    expected_capture_pence: 527,
    provider_captured_pence: 780,
    refunded_amount_pence: 253,
    gross_overcapture_pence: 253,
  });
  assertEquals(r.gross_overcapture_pence, 253);
  assertEquals(r.net_charged_pence, 527);
  assertEquals(r.outstanding_customer_overcharge_pence, 0);
  assertEquals(r.resolved_overcapture_pence, 253);
  assertEquals(r.refund_beyond_gross_overcapture_pence, 0);
});

Deno.test("MK-260719-007: gross 300, refund 600 → outstanding 0, beyond 300", () => {
  const r = resolveOvercaptureCustomerPosition({
    expected_capture_pence: 816,
    provider_captured_pence: 1116,
    refunded_amount_pence: 600,
    gross_overcapture_pence: 300,
  });
  assertEquals(r.gross_overcapture_pence, 300);
  assertEquals(r.net_charged_pence, 516);
  assertEquals(r.outstanding_customer_overcharge_pence, 0);
  assertEquals(r.resolved_overcapture_pence, 300);
  assertEquals(r.refund_beyond_gross_overcapture_pence, 300);
});

Deno.test("£5.53 KPI pair sums: gross 553, outstanding 0, resolved 553", () => {
  const rows = [
    resolveOvercaptureCustomerPosition({
      expected_capture_pence: 816,
      provider_captured_pence: 1116,
      refunded_amount_pence: 600,
      gross_overcapture_pence: 300,
    }),
    resolveOvercaptureCustomerPosition({
      expected_capture_pence: 527,
      provider_captured_pence: 780,
      refunded_amount_pence: 253,
      gross_overcapture_pence: 253,
    }),
  ];
  const t = sumOvercaptureResolutionTotals(rows);
  assertEquals(t.gross_overcapture_pence, 553);
  assertEquals(t.resolved_overcapture_pence, 553);
  assertEquals(t.outstanding_customer_overcharge_pence, 0);
  assertEquals(t.refund_beyond_gross_overcapture_pence, 300);
});

Deno.test("partial refund leaves outstanding overcharge", () => {
  const r = resolveOvercaptureCustomerPosition({
    expected_capture_pence: 500,
    provider_captured_pence: 800,
    refunded_amount_pence: 100,
    gross_overcapture_pence: 300,
  });
  assertEquals(r.net_charged_pence, 700);
  assertEquals(r.outstanding_customer_overcharge_pence, 200);
  assertEquals(r.resolved_overcapture_pence, 100);
});
