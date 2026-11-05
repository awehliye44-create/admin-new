/**
 * Pure unit coverage for same-booking matching (MK-261105-002 races).
 * Run: deno test -A supabase/functions/_shared/sameBookingAttemptSSOT.test.ts
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { isSameVerifiedBookingAttempt } from "./sameBookingAttemptSSOT.ts";

Deno.test("webhook-first then CTAP: same CAI adopts", () => {
  assertEquals(
    isSameVerifiedBookingAttempt(
      {
        passenger_id: "p",
        client_action_id: "cai",
        provider_order_id: "ord",
      },
      { passengerId: "p", clientActionId: "cai", providerOrderId: "ord" },
    ),
    true,
  );
});

Deno.test("genuine schedule conflict: different CAI/order rejects", () => {
  assertEquals(
    isSameVerifiedBookingAttempt(
      {
        passenger_id: "p",
        client_action_id: "cai-other",
        provider_order_id: "ord-other",
        payment_session_id: "ps-other",
      },
      {
        passengerId: "p",
        clientActionId: "cai-new",
        providerOrderId: "ord-new",
        paymentSessionId: "ps-new",
      },
    ),
    false,
  );
});

Deno.test("replacement auth: old order is not same attempt", () => {
  assertEquals(
    isSameVerifiedBookingAttempt(
      {
        passenger_id: "p",
        client_action_id: "cai-2",
        provider_order_id: "ord-new",
        payment_session_id: "ps-new",
      },
      {
        passengerId: "p",
        clientActionId: "cai-1",
        providerOrderId: "ord-old",
        paymentSessionId: "ps-old",
      },
    ),
    false,
  );
});
