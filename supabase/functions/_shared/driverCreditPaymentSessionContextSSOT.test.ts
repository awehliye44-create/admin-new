import { assertEquals } from "jsr:@std/assert@1";
import {
  mapPaymentSessionToDriverCreditContext,
  pickPrimaryPaymentSessionForTrip,
} from "./driverCreditPaymentSessionContextSSOT.ts";

Deno.test("pickPrimaryPaymentSessionForTrip prefers highest capture", () => {
  const picked = pickPrimaryPaymentSessionForTrip([
    { id: "a", captured_amount_pence: 500, provider_state: "CAPTURED" },
    { id: "b", captured_amount_pence: 900, provider_state: "CAPTURED" },
    { id: "c", captured_amount_pence: 0, provider_state: "AUTHORISED" },
  ]);
  assertEquals(picked?.id, "b");
});

Deno.test("mapPaymentSessionToDriverCreditContext maps provider fields", () => {
  const ctx = mapPaymentSessionToDriverCreditContext({
    id: "ps-1",
    purpose: "RIDE_BOOKING",
    provider_state: "AUTHORISED",
    captured_amount_pence: null,
    captured_at: null,
    released_amount_pence: 0,
    refunded_amount_pence: 0,
  });
  assertEquals(ctx.payment_session_id, "ps-1");
  assertEquals(ctx.provider_state, "AUTHORISED");
  assertEquals(ctx.captured_pence, null);
  assertEquals(ctx.purpose, "RIDE_BOOKING");
});
