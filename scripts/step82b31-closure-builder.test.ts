/**
 * Step 8.2B3.1 — closure builder unit tests.
 */
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildClosure,
  extractLocalSpecifiers,
} from "./step82b31-closure-builder.ts";
import { join, resolve } from "https://deno.land/std@0.224.0/path/mod.ts";

const REPO = resolve(new URL(".", import.meta.url).pathname, "..");
const TMP = await Deno.makeTempDir({ prefix: "step82b31-closure-test-" });

Deno.test("extractLocalSpecifiers finds value, type, export-from, dynamic", () => {
  const src = `
    import { a } from "./a.ts";
    import type { B } from "../_shared/b.ts";
    export { c } from "./c.ts";
    export * from "./d.ts";
    const x = await import("./e.ts");
  `;
  const specs = extractLocalSpecifiers(src);
  assert(specs.includes("./a.ts"));
  assert(specs.includes("../_shared/b.ts"));
  assert(specs.includes("./c.ts"));
  assert(specs.includes("./d.ts"));
  assert(specs.includes("./e.ts"));
});

Deno.test("revolut-capture-order closure is minimal", async () => {
  const out = join(TMP, "revolut-capture-order");
  const r = await buildClosure({ slug: "revolut-capture-order", outDir: out, skipDenoCheck: true });
  assertEquals(r.unresolved.length, 0);
  assertEquals(r.excluded_violations.length, 0);
  assert(r.local_file_count <= 10, `expected minimal graph, got ${r.local_file_count} files`);
});

Deno.test("admin-capture-trip-payment includes paymentSessionFinancialLockSSOT", async () => {
  const out = join(TMP, "admin-capture-trip-payment");
  const r = await buildClosure({ slug: "admin-capture-trip-payment", outDir: out, skipDenoCheck: true });
  assertEquals(r.unresolved.length, 0);
  const dests = r.import_edges.map((e) => e.dest_workdir_path);
  assert(
    dests.some((d) => d.includes("paymentSessionFinancialLockSSOT.ts")),
    "missing paymentSessionFinancialLockSSOT.ts in closure",
  );
  assert(
    dests.some((d) => d.includes("applyCanonicalSettlementAfterCapture.ts")),
    "missing applyCanonicalSettlementAfterCapture.ts",
  );
  assert(
    dests.some((d) => d.includes("shared/paymentHoldProviderTerminalPure.ts")),
    "missing repo-root shared dependency",
  );
});

Deno.test("admin-capture closure file count >> incomplete Phase 1 allow-list", async () => {
  const out = join(TMP, "admin-capture-count");
  const r = await buildClosure({ slug: "admin-capture-trip-payment", outDir: out, skipDenoCheck: true });
  assert(r.local_file_count >= 40, `expected large closure, got ${r.local_file_count}`);
});
