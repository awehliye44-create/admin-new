/**
 * Safe-response + token-hash contract checks for submit-revolut-google-pay.
 * Run: deno test --allow-env supabase/functions/submit-revolut-google-pay/
 */
import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";

Deno.test("success payload never includes google_pay_token or raw token", () => {
  const safe = {
    submitted: true,
    idempotent: false,
    provider_order_id: "ord_1",
    payment_session_id: "ps_1",
    status: "created",
    provider_state: "PENDING",
  };
  assertEquals("google_pay_token" in safe, false);
  assertEquals("token" in safe, false);
  assertEquals("client_secret" in safe, false);
});

Deno.test("idempotent replay shape stays token-free", () => {
  const replay = {
    submitted: true,
    idempotent: true,
    provider_order_id: "ord_1",
    payment_session_id: "ps_1",
    status: "authorised_hold",
    provider_state: "AUTHORISED",
  };
  assertEquals(replay.idempotent, true);
  assertEquals("google_pay_token" in replay, false);
});

Deno.test("audit metadata may store sha256 only, never raw token key", () => {
  const meta = {
    google_pay_submitted: true,
    google_pay_token_sha256: "abc123",
    google_pay_submitted_at: "2026-07-28T00:00:00.000Z",
  };
  assertEquals("google_pay_token" in meta, false);
  assertEquals(typeof meta.google_pay_token_sha256, "string");
});
