/**
 * Step 8.2A.1 — admin capture precondition unit tests.
 *
 * Run:
 *   deno test --allow-read supabase/functions/_shared/adminCaptureTripPaymentPreconditions.test.ts
 */
import { assertStrictEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  validateAdminCaptureTripPreconditions,
  ADMIN_CAPTURE_PRECONDITION,
} from "./adminCaptureTripPaymentPreconditions.ts";
import { FINANCIAL_MODEL_VIOLATION, SERVICE_AREA_FINANCIAL_MODEL } from "./commissionWalletSSOT.ts";

const TRIP = {
  id: "trip-1",
  status: "completed",
  financial_model: "PLATFORM_COLLECTED",
  driver_id: "driver-1",
  final_customer_fare_pence: 500,
  commissionable_fare_pence: 500,
  commission_pence: 75,
  driver_net_pence: 425,
  settlement_formula_version: "2",
};

Deno.test("requires PLATFORM_COLLECTED explicitly", () => {
  const r = validateAdminCaptureTripPreconditions({
    trip: { ...TRIP, financial_model: "OTHER" },
  });
  assertStrictEquals(r.ok, false);
  if (!r.ok) {
    assertStrictEquals(r.error_code, ADMIN_CAPTURE_PRECONDITION.FINANCIAL_MODEL_NOT_PLATFORM_COLLECTED);
  }
});

Deno.test("blocks DRIVER_COLLECTED before any provider path", () => {
  const r = validateAdminCaptureTripPreconditions({
    trip: { ...TRIP, financial_model: SERVICE_AREA_FINANCIAL_MODEL.DRIVER_COLLECTED_COMMISSION_WALLET },
  });
  assertStrictEquals(r.ok, false);
  if (!r.ok) assertStrictEquals(r.error_code, FINANCIAL_MODEL_VIOLATION);
});

Deno.test("completed trip with valid stamps resolves canonical payable", () => {
  const r = validateAdminCaptureTripPreconditions({ trip: TRIP });
  assertStrictEquals(r.ok, true);
  if (r.ok) {
    assertStrictEquals(r.canonicalPayablePence, 500);
    assertStrictEquals(r.captureAmountPence, 500);
  }
});

Deno.test("capture amount mismatch fails closed", () => {
  const r = validateAdminCaptureTripPreconditions({ trip: TRIP, amountPence: 480 });
  assertStrictEquals(r.ok, false);
  if (!r.ok) assertStrictEquals(r.error_code, ADMIN_CAPTURE_PRECONDITION.CAPTURE_AMOUNT_MISMATCH);
});

Deno.test("exact canonical payable passes", () => {
  const r = validateAdminCaptureTripPreconditions({ trip: TRIP, amountPence: 500 });
  assertStrictEquals(r.ok, true);
});

Deno.test("+1p capture mismatch fails closed", () => {
  const r = validateAdminCaptureTripPreconditions({ trip: TRIP, amountPence: 501 });
  assertStrictEquals(r.ok, false);
  if (!r.ok) assertStrictEquals(r.error_code, ADMIN_CAPTURE_PRECONDITION.CAPTURE_AMOUNT_MISMATCH);
});

Deno.test("−1p capture mismatch fails closed", () => {
  const r = validateAdminCaptureTripPreconditions({ trip: TRIP, amountPence: 499 });
  assertStrictEquals(r.ok, false);
  if (!r.ok) assertStrictEquals(r.error_code, ADMIN_CAPTURE_PRECONDITION.CAPTURE_AMOUNT_MISMATCH);
});
