/**
 * Phase 4 commitment gate must be a static import in Edge entrypoints.
 * Dynamic import("../_shared/scheduledCommitmentOfferGateSSOT.ts") omitted the
 * module from the Supabase Edge bundle → Driver Accept:
 * TypeError: Module not found: scheduledCommitmentOfferGateSSOT.ts
 */
import { assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { fromFileUrl } from "https://deno.land/std@0.224.0/path/from_file_url.ts";
import { join } from "https://deno.land/std@0.224.0/path/join.ts";

const REPO = fromFileUrl(new URL("../../..", import.meta.url));

const ENTRYPOINTS = [
  "supabase/functions/accept-offer/index.ts",
  "supabase/functions/auto-dispatch/index.ts",
  "supabase/functions/scheduled-ride-action/index.ts",
  "supabase/functions/admin-scheduled-ride-action/index.ts",
] as const;

const SHARED = [
  "supabase/functions/_shared/scheduledCommitmentOfferGateSSOT.ts",
  "supabase/functions/_shared/scheduledCommitmentFeasibilitySSOT.ts",
] as const;

function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
}

Deno.test("commitment SSOT files exist for Edge bundling", async () => {
  for (const rel of SHARED) {
    const st = await Deno.stat(join(REPO, rel));
    assert(st.isFile);
  }
});

Deno.test("accept-offer / dispatch / scheduled actions statically import commitment gate", async () => {
  for (const rel of ENTRYPOINTS) {
    const raw = await Deno.readTextFile(join(REPO, rel));
    const src = stripComments(raw);
    assert(
      src.includes('from "../_shared/scheduledCommitmentOfferGateSSOT.ts"'),
      `${rel} must statically import scheduledCommitmentOfferGateSSOT`,
    );
    assert(
      !/await\s+import\(\s*["']\.\.\/_shared\/scheduledCommitmentOfferGateSSOT\.ts["']\s*\)/.test(
        src,
      ),
      `${rel} must not dynamically import scheduledCommitmentOfferGateSSOT`,
    );
  }
});

Deno.test("accept-offer catch does not String(error) to clients", async () => {
  const src = stripComments(
    await Deno.readTextFile(join(REPO, "supabase/functions/accept-offer/index.ts")),
  );
  assert(src.includes('"Unable to accept this offer. Please try again."'));
  assert(!/errorResponse\(\s*"INTERNAL_ERROR"\s*,\s*String\(\s*error\s*\)/.test(src));
});
