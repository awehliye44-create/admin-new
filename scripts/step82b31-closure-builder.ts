#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run
/**
 * Step 8.2B3.1 — recursive TypeScript import closure builder for forward deploy workdirs.
 * Deterministic: walks static/dynamic relative imports from function entrypoints only.
 */
import { parseArgs } from "https://deno.land/std@0.224.0/cli/parse_args.ts";
import { crypto } from "https://deno.land/std@0.224.0/crypto/mod.ts";
import {
  dirname,
  join,
  relative,
  resolve,
  fromFileUrl,
} from "https://deno.land/std@0.224.0/path/mod.ts";

const REPO_ROOT = resolve(fromFileUrl(new URL(".", import.meta.url)), "..");

const EXCLUDED_PATH_FRAGMENTS = [
  "admin-recover-mk007-mk009-wallet",
  "resolve-service-area",
  "/.audit-",
  "MK-260818",
  "MK-007",
  "MK-009",
];

const LOCAL_SPEC_RE =
  /(?:import\s*(?:type\s*)?(?:[\w$*\s{},]*\sfrom\s*)?|export\s+(?:type\s+)?(?:\*|\{[^}]*\})\s+from\s+|import\s*\(\s*)["'](\.\.?\/[^"']+)["']/g;

export type ImportEdge = {
  importer: string;
  specifier: string;
  source_repo_path: string;
  dest_workdir_path: string;
  sha256: string;
};

export type ClosureResult = {
  slug: string;
  workdir: string;
  tree_sha256: string;
  local_file_count: number;
  import_edges: ImportEdge[];
  unresolved: { importer: string; specifier: string }[];
  excluded_violations: string[];
  duplicate_dest_conflicts: { dest: string; sha_a: string; sha_b: string }[];
  remote_specifiers: string[];
};

async function exists(p: string): Promise<boolean> {
  try {
    await Deno.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function sha256File(p: string): Promise<string> {
  const data = await Deno.readFile(p);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Dir(dir: string): Promise<string> {
  const proc = new Deno.Command("tar", { args: ["-cf", "-", "-C", dir, "."], stdout: "piped" });
  const { stdout, code } = await proc.output();
  if (code !== 0) throw new Error(`tar failed ${dir}`);
  const hash = await crypto.subtle.digest("SHA-256", stdout);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function isExcluded(repoPath: string): boolean {
  const norm = repoPath.replaceAll("\\", "/");
  return EXCLUDED_PATH_FRAGMENTS.some((f) => norm.includes(f));
}

function isRemoteSpecifier(spec: string): boolean {
  return (
    spec.startsWith("https://") ||
    spec.startsWith("http://") ||
    spec.startsWith("npm:") ||
    spec.startsWith("jsr:")
  );
}

export function extractLocalSpecifiers(source: string): string[] {
  const out = new Set<string>();
  for (const m of source.matchAll(LOCAL_SPEC_RE)) out.add(m[1]);
  return [...out];
}

async function resolveRepoImport(baseRepoFile: string, spec: string): Promise<string | null> {
  const base = dirname(baseRepoFile);
  let c = resolve(base, spec);
  if (await exists(c) && (await Deno.stat(c)).isFile) return c;
  if (await exists(`${c}.ts`)) return `${c}.ts`;
  if (await exists(join(c, "index.ts"))) return join(c, "index.ts");
  return null;
}

function repoPathToWorkdirDest(outDir: string, repoPath: string): string {
  const norm = repoPath.replaceAll("\\", "/");
  const repo = REPO_ROOT.replaceAll("\\", "/");
  if (!norm.startsWith(repo + "/")) {
    throw new Error(`Source outside repo: ${repoPath}`);
  }
  const rel = norm.slice(repo.length + 1);
  if (rel.startsWith("supabase/functions/")) {
    return join(outDir, rel);
  }
  if (rel.startsWith("shared/")) {
    return join(outDir, rel);
  }
  throw new Error(`Unsupported repo-relative path: ${rel}`);
}

function repoFileForWorkdirFile(workdirFile: string, outDir: string, slug: string): string {
  const rel = relative(outDir, workdirFile).replaceAll("\\", "/");
  return join(REPO_ROOT, rel);
}

async function copyFileEnsuringDir(src: string, dest: string) {
  await Deno.mkdir(dirname(dest), { recursive: true });
  await Deno.copyFile(src, dest);
}

export async function buildClosure(args: {
  slug: string;
  outDir: string;
  skipDenoCheck?: boolean;
}): Promise<ClosureResult> {
  const { slug, outDir } = args;
  const entryRepo = join(REPO_ROOT, "supabase/functions", slug, "index.ts");
  if (!(await exists(entryRepo))) {
    throw new Error(`Missing entrypoint: ${entryRepo}`);
  }

  await Deno.mkdir(outDir, { recursive: true });
  const outFunctions = join(outDir, "supabase/functions");
  await Deno.mkdir(join(outFunctions, slug), { recursive: true });
  await Deno.mkdir(join(outFunctions, "_shared"), { recursive: true });
  await Deno.mkdir(join(outDir, "shared"), { recursive: true });

  const configToml = join(outDir, "supabase/config.toml");
  await Deno.writeTextFile(configToml, 'project_id = "forward-deploy-local"\n');

  const denoJsonSrc = join(REPO_ROOT, "supabase/functions/deno.json");
  if (await exists(denoJsonSrc)) {
    await copyFileEnsuringDir(denoJsonSrc, join(outFunctions, "deno.json"));
  } else {
    await Deno.writeTextFile(
      join(outFunctions, "deno.json"),
      JSON.stringify({ nodeModulesDir: "auto" }, null, 2) + "\n",
    );
  }

  const importEdges: ImportEdge[] = [];
  const unresolved: { importer: string; specifier: string }[] = [];
  const excludedViolations: string[] = [];
  const duplicateDestConflicts: { dest: string; sha_a: string; sha_b: string }[] = [];
  const remoteSpecifiers = new Set<string>();
  const destHashes = new Map<string, string>();

  const queue: { repoFile: string; workdirFile: string }[] = [];
  const seenRepo = new Set<string>();

  const entryDest = join(outFunctions, slug, "index.ts");
  queue.push({ repoFile: entryRepo, workdirFile: entryDest });

  while (queue.length) {
    const { repoFile, workdirFile } = queue.shift()!;
    if (seenRepo.has(repoFile)) continue;
    seenRepo.add(repoFile);

    if (isExcluded(repoFile)) {
      excludedViolations.push(repoFile);
      continue;
    }

    const relToRepo = relative(REPO_ROOT, repoFile).replaceAll("\\", "/");
    const allowed = relToRepo.startsWith("supabase/functions/") || relToRepo.startsWith("shared/");
    if (!allowed) {
      excludedViolations.push(repoFile);
      continue;
    }

    const sha = await sha256File(repoFile);
    if (destHashes.has(workdirFile) && destHashes.get(workdirFile) !== sha) {
      duplicateDestConflicts.push({
        dest: workdirFile,
        sha_a: destHashes.get(workdirFile)!,
        sha_b: sha,
      });
    } else {
      destHashes.set(workdirFile, sha);
    }

    await copyFileEnsuringDir(repoFile, workdirFile);

    const source = await Deno.readTextFile(repoFile);
    for (const spec of extractLocalSpecifiers(source)) {
      if (isRemoteSpecifier(spec)) {
        remoteSpecifiers.add(spec);
        continue;
      }
      const resolved = await resolveRepoImport(repoFile, spec);
      if (!resolved) {
        unresolved.push({
          importer: relative(outDir, workdirFile),
          specifier: spec,
        });
        continue;
      }
      if (isExcluded(resolved)) {
        excludedViolations.push(resolved);
        continue;
      }
      const dest = repoPathToWorkdirDest(outDir, resolved);
      importEdges.push({
        importer: relative(outDir, workdirFile),
        specifier: spec,
        source_repo_path: relative(REPO_ROOT, resolved),
        dest_workdir_path: relative(outDir, dest),
        sha256: await sha256File(resolved),
      });
      queue.push({ repoFile: resolved, workdirFile: dest });
    }

    // Remote URL imports (record only)
    for (const m of source.matchAll(/(?:from|import)\s+["']((?:https?:\/\/|npm:|jsr:)[^"']+)["']/g)) {
      remoteSpecifiers.add(m[1]);
    }
  }

  const treeSha = await sha256Dir(outDir);
  const localFiles: string[] = [];
  async function walk(d: string) {
    for await (const e of Deno.readDir(d)) {
      const p = join(d, e.name);
      if (e.isDirectory) await walk(p);
      else localFiles.push(p);
    }
  }
  await walk(outDir);

  const manifest = {
    slug,
    workdir: outDir,
    tree_sha256: treeSha,
    local_file_count: localFiles.length,
    import_edges: importEdges,
    unresolved,
    excluded_violations: excludedViolations,
    duplicate_dest_conflicts: duplicateDestConflicts,
    remote_specifiers: [...remoteSpecifiers].sort(),
    built_at: new Date().toISOString(),
  };

  await Deno.writeTextFile(
    join(outDir, "CLOSURE_MANIFEST.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );

  if (!args.skipDenoCheck && unresolved.length === 0 && duplicateDestConflicts.length === 0) {
    const check = new Deno.Command("deno", {
      args: ["check", join(outFunctions, slug, "index.ts")],
      cwd: outDir,
      stdout: "piped",
      stderr: "piped",
    });
    const out = await check.output();
    manifest.deno_check_ok = out.code === 0;
    if (out.code !== 0) {
      manifest.deno_check_stderr = new TextDecoder().decode(out.stderr).slice(0, 4000);
    }
    await Deno.writeTextFile(join(outDir, "CLOSURE_MANIFEST.json"), JSON.stringify(manifest, null, 2) + "\n");
  }

  return {
    slug,
    workdir: outDir,
    tree_sha256: treeSha,
    local_file_count: localFiles.length,
    import_edges: importEdges,
    unresolved,
    excluded_violations: excludedViolations,
    duplicate_dest_conflicts: duplicateDestConflicts,
    remote_specifiers: [...remoteSpecifiers].sort(),
  };
}

if (import.meta.main) {
  const args = parseArgs(Deno.args, {
    string: ["slug", "out-dir"],
    boolean: ["skip-deno-check"],
  });
  const slug = String(args.slug ?? "");
  const outDir = resolve(String(args["out-dir"] ?? ""));
  if (!slug || !outDir) {
    console.error("Usage: step82b31-closure-builder.ts --slug SLUG --out-dir PATH");
    Deno.exit(1);
  }
  const result = await buildClosure({ slug, outDir, skipDenoCheck: args["skip-deno-check"] });
  console.log(JSON.stringify(result, null, 2));
  if (
    result.unresolved.length > 0 ||
    result.excluded_violations.length > 0 ||
    result.duplicate_dest_conflicts.length > 0
  ) {
    Deno.exit(1);
  }
}
