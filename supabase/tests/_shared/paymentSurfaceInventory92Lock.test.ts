/**
 * #92 exhaustive Class-A INCREMENT/CAPTURE POST inventory lock.
 * Every live trip capture/increment hub must go through claim/guard helpers.
 * Create-order / refund / cancel / release are listed but out of fence scope for #92 capture/increment.
 */
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";

const INCREMENT_CAPTURE_HUBS = [
  "../../functions/_shared/executeSameOrderIncrementSSOT.ts",
  "../../functions/_shared/revolutCompletionCapture.ts",
  "../../functions/admin-capture-trip-payment/lib/adminCaptureTripPaymentSSOT.ts",
  "../../functions/_shared/guardedProviderCaptureSSOT.ts",
] as const;

Deno.test("#92 Class A increment/capture hubs are fenced", async () => {
  const increment = await Deno.readTextFile(
    new URL(INCREMENT_CAPTURE_HUBS[0], import.meta.url),
  );
  assert(increment.includes("claimFinancialOperationForPost"));
  assert(increment.includes("incrementRevolutOrderAuthorisation"));

  const completion = await Deno.readTextFile(
    new URL(INCREMENT_CAPTURE_HUBS[1], import.meta.url),
  );
  assert(completion.includes("guardedCaptureRevolutOrder"));
  assertEquals(completion.includes("await captureRevolutOrder("), false);

  const admin = await Deno.readTextFile(
    new URL(INCREMENT_CAPTURE_HUBS[2], import.meta.url),
  );
  assert(admin.includes("guardedCaptureRevolutOrder"));

  const guarded = await Deno.readTextFile(
    new URL(INCREMENT_CAPTURE_HUBS[3], import.meta.url),
  );
  assert(guarded.includes("claimFinancialOperationForPost"));
  assert(guarded.includes("captureRevolutOrder"));
  assert(guarded.includes("retrieveRevolutOrder"));
});

Deno.test("#92 inventory: create/refund/cancel primitives remain in revolutOrders (not redesigned)", async () => {
  const orders = await Deno.readTextFile(
    new URL("../../functions/_shared/revolutOrders.ts", import.meta.url),
  );
  for (const sym of [
    "createRevolutOrder",
    "captureRevolutOrder",
    "incrementRevolutOrderAuthorisation",
    "cancelRevolutOrder",
    "refundRevolutOrder",
  ]) {
    assert(orders.includes(`export async function ${sym}`), sym);
  }
});

Deno.test("#92A fee/terminal/lifecycle captures use guardedCapture (non-fare purpose)", async () => {
  const terminal = await Deno.readTextFile(
    new URL("../../functions/_shared/terminalTripPaymentDisposition.ts", import.meta.url),
  );
  assert(terminal.includes("guardedCaptureRevolutOrder"));
  assert(terminal.includes('purpose: "terminal_fee"'));
  assertEquals(terminal.includes("await captureRevolutOrder("), false);

  const release = await Deno.readTextFile(
    new URL("../../functions/_shared/revolutPreauthReleaseSSOT.ts", import.meta.url),
  );
  assert(release.includes("guardedCaptureRevolutOrder"));
  assert(release.includes('purpose: "lifecycle_fee"'));
  assertEquals(release.includes("await captureRevolutOrder("), false);
});

Deno.test("#92A revolutAdapter.capturePayment fails closed (no unprotected CAPTURE POST)", async () => {
  const adapter = await Deno.readTextFile(
    new URL("../../functions/_shared/paymentProviders/revolutAdapter.ts", import.meta.url),
  );
  assert(adapter.includes("PAYMENT_PROVIDER_CAPTURE_BLOCKED"));
  assertEquals(adapter.includes("/orders/${providerPaymentId}/capture"), false);
  assertEquals(adapter.includes("`/orders/${providerPaymentId}/capture`"), false);
});

Deno.test("#92A Admin Payment Sessions evidence exposes required financial fields", async () => {
  const panel = await Deno.readTextFile(
    new URL("../../../src/components/finance/PaymentSessionsListPanel.tsx", import.meta.url),
  );
  for (const needle of [
    "Final payable",
    "Authorised",
    "Capture requested",
    "Provider-confirmed capture",
    "Capture classification",
    "Outstanding authorisation",
    "Customer receivable",
    "Financial operation state",
    "Recovery required",
    "Last provider reconciliation",
  ]) {
    assert(panel.includes(needle), needle);
  }
});
