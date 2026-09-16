/**
 * Lock: successful provider capture must not be reported as capture failure
 * when settlement/wallet posting fails. No second provider capture.
 *
 * Run:
 *   deno test --allow-read supabase/functions/_shared/revolutCompletionCapturePostingLock.test.ts
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  attachCapturedPostCaptureFields,
  postingWalletMismatch,
} from "./postCaptureSettlementResult.ts";

Deno.test("structured degraded result keeps success=true and retry_provider_capture=false", () => {
  const posting = postingWalletMismatch({
    settlement_status: "FAILED",
    expectedPence: 425,
    postedPence: 0,
  });
  const result = attachCapturedPostCaptureFields({
    success: true,
    status: "captured",
    capture_amount_pence: 480,
    provider_order_id: "order-1",
  }, posting);
  assertEquals(result.success, true);
  assertEquals(result.provider_capture_status, "CAPTURED");
  assertEquals(result.settlement_status, "FAILED");
  assertEquals(result.wallet_posting_status, "FAILED");
  assertEquals(result.reconciliation_status, "WALLET_MISMATCH");
  assertEquals(result.retry_provider_capture, false);
  assertEquals("error" in result && result.error != null, false);
});

Deno.test("revolutCompletionCapture propagates posting result and does not swallow as silent success", async () => {
  const src = await Deno.readTextFile(new URL("./revolutCompletionCapture.ts", import.meta.url));
  const resultSrc = await Deno.readTextFile(new URL("./postCaptureSettlementResult.ts", import.meta.url));
  assertStringIncludes(src, "capturedWithPosting");
  assertStringIncludes(src, "attachCapturedPostCaptureFields");
  assertStringIncludes(src, "const posting = await ensurePostCaptureSettlement");
  assertStringIncludes(resultSrc, "retry_provider_capture: false");
  assertEquals(
    src.includes("await ensurePostCaptureSettlement(decision.captureAmountPence);\n        return {"),
    false,
  );
});

Deno.test("finalize-trip-and-capture HTTP status follows capture success, not wallet mismatch", async () => {
  const src = await Deno.readTextFile(
    new URL("../finalize-trip-and-capture/index.ts", import.meta.url),
  );
  assertStringIncludes(src, "status: revolutResult.success ? 200 : 400");
  assertEquals(src.includes("wallet_posting_status"), false);
  assertEquals(src.includes('status: "capture_failed"') && src.includes("persistDurableOutcome"), true);
});

Deno.test("invokeFinalizeTripCapture retries only on HTTP/BOOT_ERROR, not wallet mismatch", async () => {
  const src = await Deno.readTextFile(new URL("./invokeFinalizeTripCapture.ts", import.meta.url));
  assertStringIncludes(src, "body?.success !== false");
  assertEquals(src.includes("wallet_posting_status"), false);
});
