/**
 * Bug #48 — Edge Functions must never import repo-root `shared/`.
 *
 * Deploy uploads only `supabase/functions/`. A `../../../shared/...` import
 * boots the worker into "Function exited due to an error" on every call
 * (MK-261118-003 Arrive at Pickup: stop-workflow 500s from 06:33–07:12 UTC
 * until Lovable redeploy da86958c moved tipWindow / dispatch radius SSOT under
 * `_shared/`).
 *
 * If this fails, fix the import — never delete or soften the lock.
 *
 * Run: deno test --no-check --allow-read supabase/tests/_shared/edgeFunctionRepoRootSharedImportLock.test.ts
 */

import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { fromFileUrl } from "https://deno.land/std@0.224.0/path/from_file_url.ts";

const FUNCTIONS_ROOT = fromFileUrl(new URL("../../functions", import.meta.url));

/** Import paths that leave the uploaded Edge bundle (repo-root shared/). */
const REPO_ROOT_SHARED_IMPORT =
  /from\s*["']((?:\.\.\/){2,}shared\/[^"']+)["']/;

function collectRepoRootSharedImports(): string[] {
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const entry of Deno.readDirSync(dir)) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory) {
        walk(path);
        continue;
      }
      if (!entry.isFile || !entry.name.endsWith(".ts")) continue;
      const src = Deno.readTextFileSync(path);
      for (const m of src.matchAll(
        /from\s*["']((?:\.\.\/){2,}shared\/[^"']+)["']/g,
      )) {
        const rel = path.slice(FUNCTIONS_ROOT.length + 1);
        hits.push(`${rel} -> ${m[1]}`);
      }
    }
  };
  walk(FUNCTIONS_ROOT);
  return hits;
}

Deno.test("Edge Functions never import repo-root shared/ (Bug #48 boot failure)", () => {
  const hits = collectRepoRootSharedImports();
  assertEquals(
    hits,
    [],
    "repo-root shared/ is not uploaded with Edge Functions — use supabase/functions/_shared/",
  );
});

Deno.test("stop-workflow tip + payment finals resolve under _shared (Bug #48)", () => {
  const src = Deno.readTextFileSync(
    `${FUNCTIONS_ROOT}/stop-workflow/index.ts`,
  );
  assertEquals(
    REPO_ROOT_SHARED_IMPORT.test(src),
    false,
    "stop-workflow must not import ../../../shared/",
  );
  // Positive anchors — Lovable da86958c permanent placement.
  if (!src.includes('../_shared/tipWindowConstants.ts')) {
    throw new Error("stop-workflow missing ../_shared/tipWindowConstants.ts");
  }
  if (!src.includes('../_shared/tripPaymentFinalised.ts')) {
    throw new Error("stop-workflow missing ../_shared/tripPaymentFinalised.ts");
  }
});
