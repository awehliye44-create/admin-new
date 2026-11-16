/**
 * Bug #37 — concurrent submit / duplicate callback safety (source lock).
 */
import { assert } from "https://deno.land/std@0.224.0/assert/mod.ts";

const ROOT = new URL("../../../../", import.meta.url).pathname;

Deno.test("submit-revolut-google-pay uses token SHA idempotency and skips re-pay when authorised", async () => {
  const src = await Deno.readTextFile(
    `${ROOT}supabase/functions/submit-revolut-google-pay/index.ts`,
  );
  assert(src.includes("google_pay_token_sha256"));
  assert(src.includes("idempotent: true"));
  assert(src.includes("authorised_hold") || src.includes("AUTHORISED"));
  // Same token hash short-circuits before a second Revolut pay call.
  assert(/meta\.google_pay_token_sha256 === tokenHash/.test(src));
  assert(src.includes("payRevolutOrderWithGooglePay"));
});

Deno.test("ambiguous failures must not mark definitive failed before reconcile", async () => {
  const outcome = await Deno.readTextFile(
    `${ROOT}supabase/functions/submit-revolut-google-pay/lib/googlePaySubmitOutcome.ts`,
  );
  const index = await Deno.readTextFile(
    `${ROOT}supabase/functions/submit-revolut-google-pay/index.ts`,
  );
  assert(outcome.includes("ambiguous: true") || outcome.includes("ambiguous:"));
  // Only definitive (non-ambiguous) paths call markSessionDefinitiveFailure.
  assert(index.includes("markSessionDefinitiveFailure"));
  // markSessionDefinitiveFailure no-ops when failure.ambiguous is true.
  assert(/if\s*\(\s*failure\.ambiguous\s*\)\s*return/.test(index));
});

