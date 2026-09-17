/**
 * Saved-card Book must not hard-fail with 409 "still processing" while a
 * Revolut pay is settling — that abandons the attempt and risks a second hold.
 * Hand off PENDING to client confirm-revolut on the same order instead.
 *
 * Run: deno test --allow-read supabase/tests/_shared/revolutSavedCardPendingHandoffLock.test.ts
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const PREAUTH = new URL(
  "../../functions/_shared/revolutPreauth.ts",
  import.meta.url,
);

Deno.test("saved-card in-flight settle hands off to confirm (no 409 still-processing)", async () => {
  const src = await Deno.readTextFile(PREAUTH);
  assertStringIncludes(src, "revolutSavedCardPendingResponse");
  assertStringIncludes(src, "hand off to confirm");
  assertStringIncludes(src, "findOpenSavedCardPaymentOnOrder");
  assertStringIncludes(src, "listRevolutOrderPayments");
  // Hard customer error path must not remain for settle-in-flight.
  assertEquals(
    src.includes("Saved card payment is still processing. Please try again in a moment."),
    false,
  );
  assertEquals(src.includes('code: "saved_card_pending"'), false);
});

Deno.test("customer CIT waits long enough to surface ACS from create-preauth", async () => {
  const src = await Deno.readTextFile(PREAUTH);
  assertStringIncludes(src, "waitForAcs");
  assertStringIncludes(src, "findRevolutOrderAuthenticationAcs");
  // Must not regress to the short ~0.85s settle poll for customer initiator.
  assertStringIncludes(src, "[0, 200, 400, 800, 1200, 1600, 2000, 2500, 3000, 2500]");
});
