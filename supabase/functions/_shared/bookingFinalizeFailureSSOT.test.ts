import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { classifyBookingFinalizeFailure } from "./bookingFinalizeFailureSSOT.ts";

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
