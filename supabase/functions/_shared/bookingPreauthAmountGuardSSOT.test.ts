import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  REVOLUT_SAVE_CARD_VERIFICATION_MINOR,
  assertBookingPreauthAmount,
} from "./bookingPreauthAmountGuardSSOT.ts";
import {
  authorisedHoldMatchesBooking,
  classifyRevolutOrderForBookingRetry,
} from "./revolutPaymentAttemptStateSSOT.ts";

Deno.test("booking preauth amount equals fare SSOT — not £1 verification", () => {
  const ok = assertBookingPreauthAmount({
    estimatedTotalPence: 1840,
    authorisedAmountPence: 1840,
  });
  assertEquals(ok.ok, true);
  if (ok.ok) assertEquals(ok.authorisedAmountPence, 1840);
});

Deno.test("rejects £1 verification amount when booking fare is higher", () => {
  const bad = assertBookingPreauthAmount({
    estimatedTotalPence: 1840,
    authorisedAmountPence: REVOLUT_SAVE_CARD_VERIFICATION_MINOR,
  });
  assertEquals(bad.ok, false);
  if (!bad.ok) assertEquals(bad.code, "VERIFICATION_AMOUNT_FOR_BOOKING");
});

Deno.test("one active attempt — unresolved must reuse, cancelled must block", () => {
  assertEquals(classifyRevolutOrderForBookingRetry("PROCESSING"), "reuse_unresolved");
  assertEquals(
    classifyRevolutOrderForBookingRetry("AUTHENTICATION_CHALLENGE"),
    "reuse_unresolved",
  );
  assertEquals(classifyRevolutOrderForBookingRetry("PENDING"), "reuse_unresolved");
  assertEquals(classifyRevolutOrderForBookingRetry("CANCELLED"), "terminal_block");
  assertEquals(classifyRevolutOrderForBookingRetry("FAILED"), "terminal_block");
  assertEquals(classifyRevolutOrderForBookingRetry("AUTHORISED"), "reuse_authorised");
});

Deno.test("cancelled cannot book — terminal_block prevents continuation", () => {
  assertEquals(classifyRevolutOrderForBookingRetry("CANCELLED"), "terminal_block");
  assertEquals(
    authorisedHoldMatchesBooking({
      orderAmountMinor: 100,
      orderCurrency: "GBP",
      expectedAmountMinor: 1840,
      expectedCurrency: "GBP",
    }),
    false,
  );
});

Deno.test("authorised hold must match exact amount and currency", () => {
  assertEquals(
    authorisedHoldMatchesBooking({
      orderAmountMinor: 1840,
      orderCurrency: "gbp",
      expectedAmountMinor: 1840,
      expectedCurrency: "GBP",
    }),
    true,
  );
});
