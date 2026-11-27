/**
 * Book-sync obs — CTAP edge stages_ms (no behaviour / financial change).
 * Session mark remains on-path (optimisation safety boundary).
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const CTAP = new URL(
  "../../functions/create-trip-after-payment/index.ts",
  import.meta.url,
).pathname;

Deno.test("CTAP wires serveWithEdgeTiming stage clock marks for book-sync RCA", async () => {
  const src = await Deno.readTextFile(CTAP);
  assertStringIncludes(src, "EdgeStageClock");
  assertStringIncludes(src, "stages?.mark(\"edge_receive\")");
  assertStringIncludes(src, "stages?.mark(\"auth_end\")");
  assertStringIncludes(src, "stages?.mark(\"payment_verify_end\")");
  assertStringIncludes(src, "stages?.mark(\"trip_insert_end\")");
  assertStringIncludes(src, "stages?.mark(\"session_mark_end\")");
  assertStringIncludes(src, "stages?.mark(\"response_ready\")");
  // Financial safety: session mark still awaited on-path (not waitUntil-only)
  assertStringIncludes(src, "await markPaymentSessionTripCreated");
  const waitUntilLines = src
    .split("\n")
    .filter((line) => line.includes("EdgeRuntime.waitUntil"));
  assertEquals(
    waitUntilLines.some((line) => line.includes("markPaymentSessionTripCreated")),
    false,
  );
});
