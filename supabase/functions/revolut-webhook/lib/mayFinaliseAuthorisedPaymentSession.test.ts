import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { mayFinaliseAuthorisedPaymentSession } from "./mayFinaliseAuthorisedPaymentSession.ts";

Deno.test("late AUTHORISED after recoverable technical failed may finalise", () => {
  assertEquals(
    mayFinaliseAuthorisedPaymentSession({
      sessionStatus: "failed",
      holdReleaseState: null,
      tripId: null,
    }),
    true,
  );
  assertEquals(
    mayFinaliseAuthorisedPaymentSession({
      sessionStatus: "pending_payment",
      tripId: null,
    }),
    true,
  );
});

Deno.test("explicit customer cancellation never finalises on late AUTHORISED", () => {
  assertEquals(
    mayFinaliseAuthorisedPaymentSession({
      sessionStatus: "cancelled",
      tripId: null,
    }),
    false,
  );
  assertEquals(
    mayFinaliseAuthorisedPaymentSession({
      sessionStatus: "failed",
      metadata: { customer_cancelled: true },
    }),
    false,
  );
  assertEquals(
    mayFinaliseAuthorisedPaymentSession({
      sessionStatus: "pending_payment",
      metadata: { sheet_cancelled: true },
    }),
    false,
  );
});

Deno.test("superseded / replacement attempt never finalises", () => {
  assertEquals(
    mayFinaliseAuthorisedPaymentSession({
      sessionStatus: "superseded",
      tripId: null,
    }),
    false,
  );
  assertEquals(
    mayFinaliseAuthorisedPaymentSession({
      sessionStatus: "failed",
      metadata: { replaced_by_session_id: "sess-new" },
    }),
    false,
  );
  assertEquals(
    mayFinaliseAuthorisedPaymentSession({
      sessionStatus: "failed",
      metadata: { replacement_order_id: "ord-new" },
    }),
    false,
  );
});

Deno.test("orphaned / never_capture / released hold never finalise", () => {
  assertEquals(
    mayFinaliseAuthorisedPaymentSession({
      sessionStatus: "payment_orphaned",
      tripId: null,
    }),
    false,
  );
  assertEquals(
    mayFinaliseAuthorisedPaymentSession({
      sessionStatus: "failed",
      alreadyOrphaned: true,
    }),
    false,
  );
  assertEquals(
    mayFinaliseAuthorisedPaymentSession({
      sessionStatus: "failed",
      metadata: { never_capture: true },
    }),
    false,
  );
  assertEquals(
    mayFinaliseAuthorisedPaymentSession({
      sessionStatus: "failed",
      holdReleaseState: "released",
    }),
    false,
  );
  assertEquals(
    mayFinaliseAuthorisedPaymentSession({
      sessionStatus: "pending_payment",
      tripId: "trip-already",
    }),
    false,
  );
});

Deno.test("orphan_reason metadata blocks late finalise before duplicate booking", () => {
  assertEquals(
    mayFinaliseAuthorisedPaymentSession({
      sessionStatus: "failed",
      metadata: { orphan_reason: "CUSTOMER_ALREADY_HAS_ACTIVE_TRIP" },
    }),
    false,
  );
});
