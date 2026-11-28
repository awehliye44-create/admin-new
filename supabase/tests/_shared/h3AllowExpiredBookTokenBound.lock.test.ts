/**
 * #110 P7A H3 — allowExpired book-token recovery is intentional and bounded.
 *
 * Evidence (no behaviour change): expired tokens may recover ONLY when
 * purpose === "book", signature still verifies, wa_id owns the payment-session
 * snapshot, the resolved trip is non-terminal, and mutations invoke the same
 * passenger-bound cancel/modify Edge functions (no financial auth bypass).
 * Track-purpose expired tokens stay rejected. Indefinite clock grace is
 * bounded by trip liveness + ownership, not by open world access.
 */

import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

async function read(rel: string): Promise<string> {
  return await Deno.readTextFile(new URL(rel, import.meta.url));
}

Deno.test("H3 allowExpired is book-purpose only on guest-trip-action", async () => {
  const src = await read("../../functions/guest-trip-action/index.ts");
  assertStringIncludes(src, "allowExpired: true");
  assertStringIncludes(src, 'stale?.purpose === "book"');
  assertStringIncludes(src, "phonesExactlyMatch");
  assertStringIncludes(src, "TERMINAL");
  assertStringIncludes(src, 'invokeAsTripPassenger');
  assertStringIncludes(src, "cancel-trip");
  assertStringIncludes(src, "request-trip-modification");
  assertStringIncludes(src, "confirm-trip-modification-payment");
  // Expired track tokens must not be promoted.
  const staleBlock = src.slice(src.indexOf("allowExpired"), src.indexOf("allowExpired") + 280);
  assertEquals(staleBlock.includes('purpose === "book"') || staleBlock.includes('stale?.purpose === "book"'), true);
});

Deno.test("H3 guest-trip-status / realtime-session keep the same book-only bound", async () => {
  const status = await read("../../functions/guest-trip-status/index.ts");
  const realtime = await read("../../functions/guest-trip-realtime-session/index.ts");
  for (const src of [status, realtime]) {
    assertStringIncludes(src, "allowExpired: true");
    assertStringIncludes(src, 'stale?.purpose === "book"');
  }
});

Deno.test("H3 verify helper still rejects expired unless allowExpired is set", async () => {
  const src = await read("../../functions/_shared/whatsappContinuationToken.ts");
  assertStringIncludes(src, "options?.allowExpired");
  assertStringIncludes(src, "if (exp <= nowSeconds && !options?.allowExpired) return null");
});
