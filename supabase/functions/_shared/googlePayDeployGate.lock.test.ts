/**
 * Bug #37 — deployment version mismatch gate.
 * Refuse to report payment fixes shipped when the verify script would block.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const ROOT = new URL("../../../", import.meta.url).pathname;

Deno.test("deploy gate script blocks without SUPABASE_ACCESS_TOKEN", async () => {
  const script = await Deno.readTextFile(
    `${ROOT}scripts/verify-critical-payment-edge-deployed.sh`,
  );
  assert(script.includes("DEPLOY_GATE_BLOCKED"));
  assert(script.includes("SUPABASE_ACCESS_TOKEN"));
  assert(script.includes("submit-revolut-google-pay"));
  assert(script.includes("DEPLOY_GATE_OK"));
  assert(script.includes("thazislrdkjpvvghtvzo"));
});

Deno.test("local submit-revolut-google-pay tree includes billing contract (must be deployed)", async () => {
  const index = await Deno.readTextFile(
    `${ROOT}supabase/functions/submit-revolut-google-pay/index.ts`,
  );
  const contract = await Deno.readTextFile(
    `${ROOT}supabase/functions/submit-revolut-google-pay/lib/googlePayBillingContract.ts`,
  );
  const fingerprint = await Deno.readTextFile(
    `${ROOT}supabase/functions/submit-revolut-google-pay/lib/googlePayDeployFingerprint.ts`,
  );
  const script = await Deno.readTextFile(
    `${ROOT}scripts/verify-critical-payment-edge-deployed.sh`,
  );
  assert(index.includes("resolveGooglePayBillingContract"));
  assert(index.includes("GOOGLE_PAY_EDGE_DEPLOY_FINGERPRINT"));
  assert(contract.includes("SW1A 1AA"));
  assert(contract.includes("isFabricatedGooglePayPostcode"));
  assert(!contract.includes('postcodeCompact === "SW1A1AA"'));
  assertEquals(contract.includes("000000") || contract.includes("/^0+$/"), true);
  assert(fingerprint.includes("BUG37_GPAY_EDGE_FINGERPRINT_v5_token_rejected_not_billing"));
  assert(script.includes("LIVE_SUBMIT_HASH"));
  assert(script.includes("mayFinaliseAuthorisedPaymentSession"));
});

