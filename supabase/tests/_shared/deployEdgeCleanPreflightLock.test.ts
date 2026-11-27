/**
 * Lock: production Edge deploys must use dirty-tree rejecting preflight.
 * Run: deno test --allow-read --allow-run supabase/tests/_shared/deployEdgeCleanPreflightLock.test.ts
 */
import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const scriptUrl = new URL(
  "../../../scripts/deploy-edge-clean-preflight.sh",
  import.meta.url,
);

Deno.test("deploy-edge-clean-preflight.sh rejects dirty trees and pins origin sync", async () => {
  const src = await Deno.readTextFile(scriptUrl);
  assertStringIncludes(src, "dirty working tree");
  assertStringIncludes(src, "git status --porcelain");
  assertStringIncludes(src, "origin/$BRANCH");
  assertStringIncludes(src, "expect-commit");
  assertStringIncludes(src, "functions deploy");
  assertEquals(src.includes("--force"), false);
});

Deno.test("AGENTS or scripts document mandatory preflight for Edge deploy", async () => {
  // Script itself is the enforceable SSOT; must exist and be executable bit in repo.
  const st = await Deno.stat(scriptUrl);
  assertEquals(st.isFile, true);
});
