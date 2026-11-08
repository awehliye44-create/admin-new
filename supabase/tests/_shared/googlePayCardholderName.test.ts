/**
 * Revolut rejects Google Pay when sanitised cardholder_name length ≤ 5.
 * If this fails, fix the resolver — never delete or soften the lock.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { assert } from "https://deno.land/std@0.224.0/assert/assert.ts";
import { fromFileUrl } from "https://deno.land/std@0.224.0/path/from_file_url.ts";
import { join } from "https://deno.land/std@0.224.0/path/join.ts";
import {
  GOOGLE_PAY_CARDHOLDER_FALLBACK,
  GOOGLE_PAY_CARDHOLDER_MIN_SANITISED_CHARS,
  isAcceptableGooglePayCardholderName,
  resolveGooglePayCardholderName,
  sanitiseGooglePayCardholderName,
} from "../../functions/_shared/googlePayCardholderName.ts";

const REPO_ROOT = fromFileUrl(new URL("../../..", import.meta.url));

Deno.test("sanitise strips digits/punctuation and keeps letters+spaces", () => {
  assertEquals(sanitiseGooglePayCardholderName("  Ali  "), "Ali");
  assertEquals(sanitiseGooglePayCardholderName("J. Doe-Smith"), "J DoeSmith");
  assertEquals(sanitiseGooglePayCardholderName(""), "");
  assertEquals(sanitiseGooglePayCardholderName(null), "");
});

Deno.test("3-letter wallet name is rejected; profile/fallback recover", () => {
  assertEquals(GOOGLE_PAY_CARDHOLDER_MIN_SANITISED_CHARS, 6);
  assertEquals(isAcceptableGooglePayCardholderName("Ali"), false);
  assertEquals(isAcceptableGooglePayCardholderName("Cardholder"), true);

  const shortWallet = resolveGooglePayCardholderName({
    walletName: "Ali",
    profileFirstName: "Alexandra",
    profileLastName: "Ng",
  });
  assertEquals(shortWallet.source, "profile");
  assert(isAcceptableGooglePayCardholderName(shortWallet.name));

  const noProfile = resolveGooglePayCardholderName({
    walletName: "Ali",
    profileFirstName: null,
    profileLastName: null,
  });
  assertEquals(noProfile, {
    name: GOOGLE_PAY_CARDHOLDER_FALLBACK,
    source: "fallback",
  });
});

Deno.test("acceptable wallet name is kept", () => {
  const kept = resolveGooglePayCardholderName({
    walletName: "Jordan Blake",
    profileFirstName: "Other",
    profileLastName: "Name",
  });
  assertEquals(kept, { name: "Jordan Blake", source: "wallet" });
});

Deno.test("submit-revolut-google-pay resolves cardholder via profile fallback + reject cleanup", async () => {
  const submit = await Deno.readTextFile(
    join(REPO_ROOT, "supabase/functions/submit-revolut-google-pay/index.ts"),
  );
  assert(
    submit.includes("resolveGooglePayCardholderName"),
    "submit must resolve cardholder via shared helper",
  );
  assert(
    submit.includes('.from("customers")'),
    "submit must load customers.first_name/last_name for fallback",
  );
  assertEquals(
    /cardholderName\s*\|\|\s*["']Cardholder["']/.test(submit),
    false,
    "must not use empty-only || Cardholder (short names still fail Revolut)",
  );
  assert(
    submit.includes("releaseHoldForPaymentSession"),
    "definitive Revolut reject must clean the pending session/order",
  );
  assert(
    submit.includes('terminalReason: "google_pay_submit_rejected"'),
    "cleanup must use google_pay_submit_rejected",
  );
  assert(
    submit.includes("cardholder_source: cardholderResolved.source"),
    "audit must record which name source was used (never the name)",
  );
});
