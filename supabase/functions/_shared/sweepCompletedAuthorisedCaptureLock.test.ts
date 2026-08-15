/**
 * Completed + AUTHORISED / capture_failed must retry finalize — never void the hold.
 * MK-260815-010 sat capture_failed while Revolut stayed AUTHORISED because the
 * 5-min sweep excluded completed trips from every recapture path.
 *
 * Run: deno test --allow-read supabase/functions/_shared/sweepCompletedAuthorisedCaptureLock.test.ts
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const sweepPath = new URL("../sweep-revolut-stale-holds/index.ts", import.meta.url);
const capturePath = new URL("./revolutCompletionCapture.ts", import.meta.url);
const stopPath = new URL("../stop-workflow/index.ts", import.meta.url);

Deno.test("sweep retries completed AUTHORISED via finalize, never dispose/void", async () => {
  const src = await Deno.readTextFile(sweepPath);
  assertStringIncludes(src, 'from "../_shared/invokeFinalizeTripCapture.ts"');
  assertStringIncludes(src, "invokeFinalizeTripCapture");
  assertStringIncludes(src, "completed_authorised_retry");
  assertStringIncludes(src, "COMPLETED_CAPTURE_RETRY_PAYMENT_STATUSES");
  assertStringIncludes(src, "capture_failed");
  assertStringIncludes(src, "COMPLETED_AUTHORISED_RETRY_GRACE_MS");
  assertStringIncludes(src, 'if (status === "completed") return false');
  assertEquals(src.includes("disposeTerminalTripPayment"), true);
  const start = src.indexOf("Completed + AUTHORISED + uncaptured");
  const end = src.indexOf("Trip-less AUTHORISED holds");
  assertEquals(start >= 0 && end > start, true);
  const retryBlock = src.slice(start, end);
  assertEquals(retryBlock.includes("invokeFinalizeTripCapture"), true);
  assertEquals(retryBlock.includes("disposeTerminalTripPayment"), false);
  assertEquals(retryBlock.includes("releaseHoldForPaymentSession"), false);
  assertEquals(retryBlock.includes("cancelRevolutOrder"), false);
  assertStringIncludes(src, "heal_captured_authorised_snapshot");
  assertStringIncludes(src, "sweep_captured_authorised_snapshot");
});

Deno.test("sweep and complete_trip statically import capture modules", async () => {
  const sweep = await Deno.readTextFile(sweepPath);
  const capture = await Deno.readTextFile(capturePath);
  const stop = await Deno.readTextFile(stopPath);
  assertEquals(/await\s+import\s*\(/.test(sweep), false);
  assertEquals(/await\s+import\s*\(/.test(capture), false);
  assertEquals(stop.includes('await import("../_shared/digitalPaymentCapture.ts")'), false);
  assertEquals(stop.includes('from "../_shared/digitalPaymentCapture.ts"'), true);
  assertEquals(sweep.includes('from "../_shared/revolutOrders.ts"'), true);
  assertEquals(sweep.includes('from "../_shared/applyCanonicalSettlementAfterCapture.ts"'), true);
});
