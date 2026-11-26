/**
 * #108 — late ORDER_AUTHORISED must not overwrite a confirmed capture.
 * MK-261126-005 / MK-261125-009.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { resolveTripPaymentStatusWrite } from "../../functions/_shared/tripPaymentStatusProjectionSSOT.ts";
import { needsDurableSettlementPersist } from "../../functions/finalize-trip-and-capture/lib/durableSettlementOutcomeSSOT.ts";

Deno.test("#108 late authorised is refused when payment_status is already captured", () => {
  const d = resolveTripPaymentStatusWrite({
    currentStatus: "captured",
    currentHoldStatus: "captured",
    captureAmountPence: 500,
    incomingStatus: "authorized",
  });
  assertEquals(d.write, false);
  assertEquals(d.refusedRegression, true);
  assertEquals(d.status, "captured");
});

Deno.test("#108 split row (authorised + captured hold) is repaired, not left authorised", () => {
  const d = resolveTripPaymentStatusWrite({
    currentStatus: "authorized",
    currentHoldStatus: "captured",
    captureAmountPence: 500,
    incomingStatus: "authorized",
  });
  assertEquals(d.write, true);
  assertEquals(d.refusedRegression, true);
  assertEquals(d.status, "captured");
});

Deno.test("#108 pre-capture authorised refresh is still written", () => {
  const d = resolveTripPaymentStatusWrite({
    currentStatus: "pending",
    currentHoldStatus: "authorized",
    captureAmountPence: null,
    incomingStatus: "authorized",
  });
  assertEquals(d.write, true);
  assertEquals(d.refusedRegression, false);
  assertEquals(d.status, "authorized");
});

Deno.test("#108 captured to refunded is not treated as a pre-capture regression", () => {
  const d = resolveTripPaymentStatusWrite({
    currentStatus: "captured",
    currentHoldStatus: "captured",
    captureAmountPence: 500,
    incomingStatus: "refunded",
  });
  assertEquals(d.write, true);
  assertEquals(d.refusedRegression, false);
  assertEquals(d.status, "refunded");
});

Deno.test("#108 shortfall over a captured trip is still persisted", () => {
  assertEquals(
    needsDurableSettlementPersist({
      paymentStatus: "captured",
      paymentHoldStatus: "captured",
      paymentState: "captured",
      finalizeSuccess: true,
      finalizeStatus: "payment_shortfall",
    }),
    true,
  );
});

Deno.test("#108 durable settlement does not downgrade a captured trip to authorized", () => {
  assertEquals(
    needsDurableSettlementPersist({
      paymentStatus: "captured",
      paymentHoldStatus: "captured",
      paymentState: "captured",
      finalizeSuccess: true,
      finalizeStatus: "unknown_finalize",
    }),
    false,
  );
});

Deno.test("#108 webhook and sweep call the projection guard", async () => {
  const webhook = await Deno.readTextFile(
    new URL("../../functions/revolut-webhook/index.ts", import.meta.url),
  );
  const sweep = await Deno.readTextFile(
    new URL("../../functions/sweep-revolut-stale-holds/index.ts", import.meta.url),
  );
  const migration = await Deno.readTextFile(
    new URL(
      "../../migrations/20270301210000_trip_payment_status_no_capture_regression_108.sql",
      import.meta.url,
    ),
  );
  assertEquals(webhook.includes("resolveTripPaymentStatusWrite"), true);
  assertEquals(webhook.includes("payment_status_regression"), true);
  assertEquals(sweep.includes("reconcileConfirmedCapturePaymentStatus"), true);
  assertEquals(migration.includes("trg_trips_payment_status_no_capture_regression"), true);
  assertEquals(migration.includes("reconcile_confirmed_capture_payment_status"), true);
  assertEquals(migration.includes("payment_ssot_cutover"), false);
  assertEquals(migration.includes("REVOKE ALL ON FUNCTION public.reconcile_confirmed_capture_payment_status"), true);
});
