/**
 * LOCK — email verify-link GET must serve the native opener HTML.
 * Do not 302 Samsung Gmail/Chrome onto a custom scheme.
 *
 * Run: deno test --allow-read supabase/functions/_shared/accountEmailVerifyLinkLock.test.ts
 */

import { assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

Deno.test("account-email-verify-link hands off via constructed intent Location", async () => {
  const src = await Deno.readTextFile(
    new URL("../account-email-verify-link/index.ts", import.meta.url),
  );
  assertStringIncludes(src, "nativeAppHandoffLocation");
  assertStringIncludes(src, 'path: "auth/verify-email"');
});

Deno.test("account-email-change-verify-link uses the same Android handoff", async () => {
  const src = await Deno.readTextFile(
    new URL("../account-email-change-verify-link/index.ts", import.meta.url),
  );
  assertStringIncludes(src, "nativeAppHandoffLocation");
  assertStringIncludes(src, 'path: "auth/verify-email-change"');
});
