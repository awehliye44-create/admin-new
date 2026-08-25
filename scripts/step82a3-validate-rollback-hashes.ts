#!/usr/bin/env -S deno run --allow-read --allow-write
/**
 * Step 8.2A.3 — Phase 1 rollback workdir per-file hashes + import graph isolation proof.
 */
import { crypto } from "https://deno.land/std@0.224.0/crypto/mod.ts";
import { join, relative, resolve, fromFileUrl, dirname } from "https://deno.land/std@0.224.0/path/mod.ts";

const REPO = resolve(fromFileUrl(new URL(".", import.meta.url)), "..");
const ROLLBACK_ROOT = join(REPO, ".rollback-step82a2-2026-08-19");

const PHASE1 = [
  { slug: "admin-capture-trip-payment", workdir: "admin-capture-trip-payment-v227-workdir", ezbr: "22b491dc0d74efa06da5fd4f22756d9bd9cf803930f9e53deaf3b2a20a060fd0" },
  { slug: "revolut-capture-order", workdir: "revolut-capture-order-v179-workdir", ezbr: "174cbb75c7e4c5d2a0f64ba958e1af6610c63c997b565080eddc4f5dbfae72b4" },
  { slug: "admin-refund-trip-payment", workdir: "admin-refund-trip-payment-v212-workdir", ezbr: "5562b951b0e0a93ef4da14064d08e2d24277b286216b1feca1577a40710e59f8" },
];

async function sha256File(path: string): Promise<string> {
  const bytes = await Deno.readFile(path);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function* walkFiles(root: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(root)) {
    const path = join(root, entry.name);
    if (entry.isDirectory) {
      if (entry.name === "node_modules" || entry.name === ".deno") continue;
      yield* walkFiles(path);
    } else if (entry.isFile) yield path;
  }
}

function extractImports(source: string): string[] {
  const out = new Set<string>();
  for (const m of source.matchAll(/(?:from|import)\s+["'](\.\.?\/[^"']+)["']/g)) out.add(m[1]);
  return [...out];
}

async function resolveImport(baseFile: string, spec: string, workdir: string): Promise<string | null> {
  let candidate = resolve(dirname(baseFile), spec);
  for (const suffix of ["", ".ts", "/index.ts"]) {
    const tryPath = suffix ? (suffix.startsWith("/") ? candidate + suffix : `${candidate}${suffix}`) : candidate;
    try {
      await Deno.stat(tryPath);
      if (!tryPath.startsWith(workdir)) return null;
      return tryPath;
    } catch { /* continue */ }
  }
  return null;
}

async function analyzeWorkdir(slug: string, workdirName: string, ezbr: string) {
  const workdir = join(ROLLBACK_ROOT, workdirName);
  const files: Array<{ relative_path: string; sha256: string }> = [];
  const importGraph: Record<string, string[]> = {};
  const externalImports: string[] = [];

  for await (const file of walkFiles(workdir)) {
    if (!/\.(ts|tsx|json|toml)$/.test(file)) continue;
    const rel = relative(workdir, file);
    files.push({ relative_path: rel, sha256: await sha256File(file) });
    if (!file.endsWith(".ts")) continue;
    const src = await Deno.readTextFile(file);
    const specs = extractImports(src);
    importGraph[rel] = specs;
    for (const spec of specs) {
      const resolved = await resolveImport(file, spec, workdir);
      if (!resolved) externalImports.push(`${rel} -> ${spec}`);
    }
  }

  return {
    slug,
    ezbr_sha256: ezbr,
    workdir: workdirName,
    file_count: files.length,
    import_graph: importGraph,
    external_import_violations: externalImports,
    resolves_dirty_shared_outside_workdir: externalImports.length > 0,
    files,
  };
}

const manifest = {
  generated_at: new Date().toISOString(),
  note: "Per-file SHA-256 within rollback workdir; import graph must not resolve outside workdir root.",
  phase_1: [] as unknown[],
};

for (const item of PHASE1) {
  manifest.phase_1.push(await analyzeWorkdir(item.slug, item.workdir, item.ezbr));
}

const outPath = join(ROLLBACK_ROOT, "PHASE1_FILE_HASH_MANIFEST.json");
await Deno.writeTextFile(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote ${outPath}`);

for (const entry of manifest.phase_1 as Array<{ slug: string; file_count: number; external_import_violations: string[] }>) {
  console.log(`${entry.slug}: files=${entry.file_count} external_violations=${entry.external_import_violations.length}`);
}
