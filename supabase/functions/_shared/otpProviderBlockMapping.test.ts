/**
 * Lock: Twilio Verify provider blocks stay a stable customer-safe code.
 * Never echo raw provider text, account IDs, or secrets.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { AUTH_ERROR, mapOtpErrorToMessage } from "./authErrorMessages.ts";

const SAFE_MESSAGE =
  "This phone number can't receive SMS codes right now (blocked by the SMS provider). Tap Change and try a different number, or contact support.";

function assertBlocked(raw: string) {
  const mapped = mapOtpErrorToMessage({ message: raw }, "send");
  assertEquals(mapped.code, "phone_blocked_by_provider");
  assertEquals(mapped.phase, "send");
  assertEquals(mapped.message, SAFE_MESSAGE);
  assertEquals(mapped.message.includes("60410"), false);
  assertEquals(mapped.message.toLowerCase().includes("twilio"), false);
  assertEquals(mapped.message.toLowerCase().includes("fraud"), false);
  assertEquals(mapped.message.includes(raw), false);
}

Deno.test("Twilio 60410 maps to phone_blocked_by_provider", () => {
  assertBlocked(
    "Twilio error 60410: The destination phone number has been temporarily blocked by Verify Geo-Permissions",
  );
});

Deno.test("fraud and prefix-block variants share the same stable code", () => {
  assertBlocked("Phone number is blocked for the SMS channel");
  assertBlocked("Prefix is blocked by the SMS provider");
  assertBlocked("Request flagged as fraudulent activity");
  assertBlocked("Destination temporarily blocked");
});

Deno.test("unrelated send failures keep the generic fallback", () => {
  const mapped = mapOtpErrorToMessage(
    { message: "upstream timeout contacting auth" },
    "send",
  );
  assertEquals(mapped.code, "send_failed");
  assertEquals(mapped.message, AUTH_ERROR.OTP_SEND_FAILED);
  assertEquals(mapped.message.includes("upstream"), false);
});

Deno.test("customer-facing blocked copy contains no secrets or raw provider details", () => {
  const secretish =
    "60410 sb_secret_example eyJhbGciOiJIUzI1NiJ9.payload.sig prefix is blocked";
  const mapped = mapOtpErrorToMessage(secretish, "send");
  assertEquals(mapped.code, "phone_blocked_by_provider");
  assertEquals(mapped.message, SAFE_MESSAGE);
  assertEquals(/sb_secret_|eyJ|60410|payload/i.test(mapped.message), false);
});
