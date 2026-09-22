/**
 * MK-260922-001 — tip window must not seal on false local capture.
 *
 * Run:
 *   deno test --allow-read supabase/tests/_shared/tipWindowEarlyCaptureLock.test.ts
 *   deno test --no-check shared/durableSettlementOutcomeSSOT.deno.test.ts
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { durableSettlementColumns } from "../../functions/_shared/durableSettlementOutcomeSSOT.ts";
import {
  isTipWindowOpen,
  needsServerTipWindowFareCapture,
  tipWindowCloseAllowedAfterFinalize,
} from "../../functions/_shared/tripPaymentFinalised.ts";
import { TIP_WINDOW_MS } from "../../functions/_shared/tipWindowConstants.ts";

const OPENED = "2026-09-22T13:35:29.543Z";
const EXPIRES = new Date(new Date(OPENED).getTime() + TIP_WINDOW_MS).toISOString();
const CLOSED_EARLY = "2026-09-22T13:35:43.688Z";

Deno.test("LOCK: TIP_WINDOW_MS is 20 minutes", () => {
  assertEquals(TIP_WINDOW_MS, 20 * 60 * 1000);
  assertEquals(EXPIRES, "2026-09-22T13:55:29.543Z");
});

Deno.test("LOCK: completion before deadline does not need expiry capture", () => {
  const trip = {
    tip_window_expires_at: EXPIRES,
    tip_window_closed_at: null,
    tip_window_status: "open",
    payment_status: "authorized",
    provider_order_id: "order-1",
  };
  const midWindow = new Date(OPENED).getTime() + 60_000;
  assertEquals(isTipWindowOpen(trip, midWindow), true);
  assertEquals(needsServerTipWindowFareCapture(trip, midWindow), false);
});

Deno.test("LOCK: tip submitted at deadline minus one second keeps window open", () => {
  const trip = {
    tip_window_expires_at: EXPIRES,
    tip_window_closed_at: null,
  };
  const oneSecondBefore = new Date(EXPIRES).getTime() - 1000;
  assertEquals(isTipWindowOpen(trip, oneSecondBefore), true);
});

Deno.test("LOCK: tipWindowCloseAllowed requires terminal capture status (not amount alone)", () => {
  // MK-260922-001 false confirmation shape
  assertEquals(
    tipWindowCloseAllowedAfterFinalize({
      success: true,
      status: "authorized",
      capture_amount_pence: 500,
      provider_state: "AUTHORISED",
    }),
    false,
  );
  assertEquals(
    tipWindowCloseAllowedAfterFinalize({
      success: true,
      status: "captured",
      capture_amount_pence: 500,
      provider_state: "AUTHORISED",
    }),
    false,
  );
  assertEquals(
    tipWindowCloseAllowedAfterFinalize({
      success: true,
      status: "captured",
      capture_amount_pence: 500,
      provider_state: "COMPLETED",
    }),
    true,
  );
  assertEquals(
    tipWindowCloseAllowedAfterFinalize({
      success: true,
      status: "already_captured",
      capture_amount_pence: 500,
    }),
    true,
  );
  assertEquals(
    tipWindowCloseAllowedAfterFinalize({
      success: true,
      capture_amount_pence: 500,
    }),
    false,
  );
});

Deno.test("LOCK: durableSettlementColumns must not invent captured from authorized+success", () => {
  assertEquals(durableSettlementColumns("authorized", true), {
    payment_status: "authorized",
    payment_hold_status: "authorized",
  });
  assertEquals(durableSettlementColumns("authorised", true), {
    payment_status: "authorized",
    payment_hold_status: "authorized",
  });
  assertEquals(durableSettlementColumns("captured", true), {
    payment_status: "captured",
    payment_hold_status: "captured",
  });
  assertEquals(durableSettlementColumns("already_captured", true), {
    payment_status: "captured",
    payment_hold_status: "captured",
  });
});

Deno.test("LOCK: early tip_window_closed_at while expires_at future is closed (not open)", () => {
  const trip = {
    tip_window_expires_at: EXPIRES,
    tip_window_closed_at: CLOSED_EARLY,
  };
  const midWindow = new Date(OPENED).getTime() + 60_000;
  assertEquals(isTipWindowOpen(trip, midWindow), false);
});

Deno.test("LOCK: source files refuse false capture / tip seal", async () => {
  const durable = await Deno.readTextFile(
    new URL("../../functions/_shared/durableSettlementOutcomeSSOT.ts", import.meta.url),
  );
  assertEquals(durable.includes("must NOT invent captured"), true);

  const tipFinal = await Deno.readTextFile(
    new URL("../../functions/_shared/tripPaymentFinalised.ts", import.meta.url),
  );
  assertEquals(tipFinal.includes("MK-260922-001"), true);
  assertEquals(tipFinal.includes("provider_state"), true);

  const capture = await Deno.readTextFile(
    new URL("../../functions/_shared/revolutCompletionCapture.ts", import.meta.url),
  );
  assertEquals(capture.includes("Provider capture not confirmed"), true);
  assertEquals(capture.includes("tip window must stay open"), true);
  // Non-terminal capture POST must GET-reconcile before local stamp.
  assertEquals(capture.includes("providerCaptureConfirmed"), true);
  assertEquals(capture.includes("retrieveRevolutOrder"), true);
  assertEquals(capture.includes("decideCaptureAfterRetrieve"), true);
  assertEquals(capture.includes("reconcile_already_captured"), true);

  const finalize = await Deno.readTextFile(
    new URL("../../functions/finalize-trip-and-capture/index.ts", import.meta.url),
  );
  assertEquals(finalize.includes("TIP_WINDOW_OPEN"), true);
  assertEquals(finalize.includes("allowOpenTipWindowCapture"), true);

  const stop = await Deno.readTextFile(
    new URL("../../functions/stop-workflow/index.ts", import.meta.url),
  );
  assertEquals(stop.includes("tip_window_capture_deferred"), true);
  assertEquals(stop.includes("deferCaptureForTipWindow"), true);

  const tipSubmit = await Deno.readTextFile(
    new URL("../../functions/submit-customer-trip-tip/index.ts", import.meta.url),
  );
  assertEquals(tipSubmit.includes("tipWindowCloseAllowedAfterFinalize"), true);
  assertEquals(tipSubmit.includes("source: \"submit_customer_trip_tip\""), true);

  const expiry = await Deno.readTextFile(
    new URL("../../functions/capture-expired-tip-windows/index.ts", import.meta.url),
  );
  assertEquals(expiry.includes("expiryFareOnlyTipPence"), true);
  assertEquals(expiry.includes("tipWindowCloseAllowedAfterFinalize"), true);
});

Deno.test("LOCK: AUTHORISED provider response cannot close tip window", () => {
  assertEquals(
    tipWindowCloseAllowedAfterFinalize({
      success: true,
      status: "authorized",
      capture_amount_pence: 500,
      provider_state: "AUTHORISED",
    }),
    false,
  );
  assertEquals(
    durableSettlementColumns("authorized", true).payment_status,
    "authorized",
  );
});
