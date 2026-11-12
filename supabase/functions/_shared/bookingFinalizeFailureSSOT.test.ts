import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  classifyBookingFinalizeFailure,
  mergeBookingFailExtraBody,
} from "./bookingFinalizeFailureSSOT.ts";

Deno.test("Scenario F: definitive advance failure vs temporary transport", () => {
  const tooSoon = classifyBookingFinalizeFailure({
    message: "SCHEDULED_ADVANCE_WINDOW: TOO_SOON — Pickup must be at least 20 minutes from now.",
  });
  assertEquals(tooSoon.class, "definitive_release");

  const temporary = classifyBookingFinalizeFailure({
    message: "Function failed to start (please check logs)",
    code: "BOOT_ERROR",
  });
  assertEquals(temporary.class, "temporary_retry");

  const adopt = classifyBookingFinalizeFailure({
    message: "CUSTOMER_ALREADY_HAS_ACTIVE_TRIP:2905e0f7-0910-4893-b0aa-23dde3c3265a",
  });
  assertEquals(adopt.class, "adopt_existing_trip");
  assertEquals(adopt.existingTripId, "2905e0f7-0910-4893-b0aa-23dde3c3265a");
});

Deno.test("CTAP create-trip-after-payment merges extraBody via protected financial keys", async () => {
  const src = await Deno.readTextFile(
    new URL("../create-trip-after-payment/index.ts", import.meta.url),
  );
  if (!src.includes("mergeBookingFailExtraBody")) {
    throw new Error("CTAP must merge fail extras via mergeBookingFailExtraBody");
  }
  if (src.includes("hold_released: true")) {
    throw new Error("CTAP must not pre-claim hold_released before release confirms");
  }
  if (/advance_failure_code:\s*advance\.code/.test(src) === false) {
    throw new Error("advance reason must be advance_failure_code, not code");
  }
});

Deno.test("CTAP extraBody cannot overwrite BOOKING_FAILED_PREAUTH_REVERSED or PAYMENT_ORPHANED", () => {
  const reversed = mergeBookingFailExtraBody(
    {
      error: "released copy",
      code: "BOOKING_FAILED_PREAUTH_REVERSED",
      charge_state: "reversed",
      failure_reason: "TOO_SOON",
    },
    {
      code: "TOO_SOON",
      hold_released: true,
      advance_failure_code: "TOO_SOON",
      booking_failure_definitive: true,
    },
  );
  assertEquals(reversed.code, "BOOKING_FAILED_PREAUTH_REVERSED");
  assertEquals(reversed.charge_state, "reversed");
  assertEquals(reversed.advance_failure_code, "TOO_SOON");
  assertEquals(reversed.hold_released, undefined);

  const orphaned = mergeBookingFailExtraBody(
    {
      error: "Payment received. We're recovering your booking.",
      code: "PAYMENT_ORPHANED",
      charge_state: "authorised_requires_recovery",
      failure_reason: "STALE_PAYMENT_ATTEMPT",
    },
    {
      code: "STALE_PAYMENT_ATTEMPT",
      hold_released: true,
      advance_failure_code: "STALE_PAYMENT_ATTEMPT",
    },
  );
  assertEquals(orphaned.code, "PAYMENT_ORPHANED");
  assertEquals(orphaned.charge_state, "authorised_requires_recovery");
  assertEquals(orphaned.advance_failure_code, "STALE_PAYMENT_ATTEMPT");
});
