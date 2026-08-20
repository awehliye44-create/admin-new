/**
 * Step 8.2A.2 — bundle boot / import resolution for Phase 1 handlers (main repo).
 *
 * Run:
 *   deno test --allow-read --no-check supabase/functions/_shared/step82a2BundleBoot.test.ts
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const HANDLERS = [
  "admin-capture-trip-payment/index.ts",
  "revolut-capture-order/index.ts",
  "admin-refund-trip-payment/index.ts",
];

const ROOT = new URL("../", import.meta.url).pathname;

for (const handler of HANDLERS) {
  Deno.test(`bundle boot: ${handler} imports resolve`, async () => {
    const proc = new Deno.Command("deno", {
      args: ["cache", handler],
      cwd: ROOT,
      stdout: "piped",
      stderr: "piped",
    });
    const out = await proc.output();
    assertEquals(out.code, 0, new TextDecoder().decode(out.stderr));
  });
}
