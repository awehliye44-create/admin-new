/**
 * Regression lock: every relative import reachable from the seven Admin RC
 * Edge entry points must exist in the committed tree (no dirty/recovery paths).
 */
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { dirname, fromFileUrl, join, normalize } from "https://deno.land/std@0.224.0/path/mod.ts";

const ENTRY_POINTS = [
  "driver-cancel-before-pickup/index.ts",
  "customer-resume-driver-search/index.ts",
  "cancel-trip/index.ts",
  "stop-workflow/index.ts",
  "confirm-trip-modification-payment/index.ts",
  "check-corporate-schedule-overlap/index.ts",
  "create-corporate-book/index.ts",
] as const;

const IMPORT_RE =
  /(?:import|export)\s+(?:type\s+)?(?:[^"'`]+from\s+)?["'](\.[^"']+)["']/g;

function functionsRoot(): string {
  // .../_shared/this.test.ts -> .../functions
  return dirname(dirname(fromFileUrl(import.meta.url)));
}

function repoRoot(): string {
  return dirname(dirname(functionsRoot()));
}

async function collectRelativeImports(entryRel: string): Promise<string[]> {
  const root = functionsRoot();
  const seen = new Set<string>();
  const missing: string[] = [];
  const queue: string[] = [join(root, entryRel)];

  while (queue.length) {
    const file = queue.pop()!;
    const norm = normalize(file);
    if (seen.has(norm)) continue;
    seen.add(norm);
    let text: string;
    try {
      text = await Deno.readTextFile(norm);
    } catch {
      missing.push(norm);
      continue;
    }
    for (const match of text.matchAll(IMPORT_RE)) {
      const spec = match[1];
      if (!spec.startsWith(".")) continue;
      // strip query (?...) if any
      const clean = spec.split("?")[0]!;
      const resolved = normalize(join(dirname(norm), clean));
      if (!seen.has(resolved)) queue.push(resolved);
    }
  }
  return missing;
}

Deno.test("RC deploy entry import graph: all relative modules exist", async () => {
  const allMissing: string[] = [];
  for (const entry of ENTRY_POINTS) {
    const missing = await collectRelativeImports(entry);
    for (const m of missing) allMissing.push(`${entry} -> ${m}`);
  }
  assertEquals(allMissing, [], `Missing relative imports:\n${allMissing.join("\n")}`);
});

Deno.test("RC deploy entries: whatsappTripLifecycleMessages must not be imported", async () => {
  const root = functionsRoot();
  for (const entry of ENTRY_POINTS) {
    const text = await Deno.readTextFile(join(root, entry));
    assert(
      !text.includes("whatsappTripLifecycleMessages"),
      `${entry} must not import whatsappTripLifecycleMessages (WhatsApp companion)`,
    );
  }
});

Deno.test("RC deploy entries: no recovery/worktree absolute imports", async () => {
  const root = functionsRoot();
  const banned = ["/_recovery/", "/worktrees/", "onecab-premium-build"];
  for (const entry of ENTRY_POINTS) {
    const text = await Deno.readTextFile(join(root, entry));
    for (const b of banned) {
      assert(!text.includes(b), `${entry} contains banned path fragment ${b}`);
    }
  }
  // silence unused
  void repoRoot;
});
