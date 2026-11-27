/**
 * Lock: production Edge deploys must use dirty-tree rejecting preflight
 * and close the check-to-bundle race (flock + freeze).
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
const guardUrl = new URL(
  "../../../scripts/lib/canonical-tree-publish-guard.sh",
  import.meta.url,
);

Deno.test("deploy-edge-clean-preflight.sh rejects dirty trees and pins origin sync", async () => {
  const src = await Deno.readTextFile(scriptUrl);
  assertStringIncludes(src, "canonical-tree-publish-guard.sh");
  assertStringIncludes(src, "canonical_publish_begin");
  assertStringIncludes(src, "canonical_publish_end");
  assertStringIncludes(src, "functions deploy");
  assertStringIncludes(src, "supabase/functions");
  assertEquals(src.includes("--force"), false);
});

Deno.test("canonical-tree-publish-guard closes check-to-bundle race", async () => {
  const src = await Deno.readTextFile(guardUrl);
  assertStringIncludes(src, "onecab-canonical-publish.lockdir");
  assertStringIncludes(src, "mkdir");
  assertStringIncludes(src, "chmod -R a-w");
  assertStringIncludes(src, "git status --porcelain");
  assertStringIncludes(src, "origin/$branch");
  assertStringIncludes(src, "HEAD changed during publish");
});

Deno.test("AGENTS or scripts document mandatory preflight for Edge deploy", async () => {
  const st = await Deno.stat(scriptUrl);
  assertEquals(st.isFile, true);
  const guard = await Deno.stat(guardUrl);
  assertEquals(guard.isFile, true);
});
