/**
 * #92G — evidence-only INCREMENT op reconcile + TCR abandon (no provider POST).
 */
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { isTerminalFinancialOpState } from "../../functions/_shared/paymentFinancialOperationSSOT.ts";

Deno.test("92G: COVER_CONFIRMED is terminal; INCREMENT_UNKNOWN is not", () => {
  assertEquals(isTerminalFinancialOpState("COVER_CONFIRMED"), true);
  assertEquals(isTerminalFinancialOpState("INCREMENT_UNKNOWN"), false);
  assertEquals(isTerminalFinancialOpState("INCREMENT_PENDING"), false);
  assertEquals(isTerminalFinancialOpState("FULLY_CAPTURED"), true);
});

Deno.test("92G: recovery module forbids TEN/capture POST side effects in source", () => {
  const ROOT = new URL("../../../", import.meta.url).pathname;
  const src = Deno.readTextFileSync(
    `${ROOT}supabase/functions/_shared/mk261125003RecoverySSOT.ts`,
  );
  assert(src.includes("Never POSTs") || src.includes("Never creates a second TEN")
    || src.includes("delegates to generic"));
  assert(!/incrementRevolutOrderAuthorisation|captureRevolutOrder\(/.test(src));
  assert(!/from\("driver_wallet_ledger"\)\.insert/.test(src));
  assert(src.includes("recoverMk261125003IntegrityGaps"));
  assert(src.includes("tenCount"));
});
