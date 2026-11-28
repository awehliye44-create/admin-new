/**
 * BR1 — HTTP business error_code must survive edge timing ops_logs.
 * performance_status stays in metadata; never replaces quote reject codes.
 *
 * Run: deno test --allow-read supabase/tests/_shared/br1BusinessErrorObservabilityLock.test.ts
 */
import {
  assertStringIncludes,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const root = new URL("../../functions/", import.meta.url);

async function read(rel: string): Promise<string> {
  return await Deno.readTextFile(new URL(rel, root));
}

Deno.test("BR1: edgeFunctionTiming extracts business error_code from non-2xx body", async () => {
  const src = await read("_shared/edgeFunctionTiming.ts");
  assertStringIncludes(src, "businessErrorCode");
  assertStringIncludes(src, "attachBusinessErrorFromResponse");
  assertStringIncludes(src, "business_error_code");
  assertStringIncludes(src, "business_error_note");
  // Prefer business code over performance_status on ops_logs.error_code.
  assertStringIncludes(src, "timer.businessErrorCode");
  assertStringIncludes(src, "opsErrorCode");
  assertEquals(src.includes("error_code: perf?.performance_status ?? undefined"), false);
});

Deno.test("BR1: serveWithEdgeTiming awaits business error attach before finish", async () => {
  const src = await read("_shared/edgeFunctionTiming.ts");
  assertStringIncludes(src, "await attachBusinessErrorFromResponse(response, timer)");
  assertStringIncludes(src, "UNHANDLED_EDGE_EXCEPTION");
});

Deno.test("BR1: quote reject payload exposes error_code + note", async () => {
  const quote = await read("_shared/bookingPaymentQuoteSSOT.ts");
  assertStringIncludes(quote, "error_code: code");
  assertStringIncludes(quote, "BOOKING_QUOTE_INVALID");
  assertStringIncludes(quote, "FARE_QUOTE_CHANGED");
  assertStringIncludes(quote, "FARE_QUOTE_EXPIRED");
});
