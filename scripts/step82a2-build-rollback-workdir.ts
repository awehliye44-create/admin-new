#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run
/**
 * Build independently deployable rollback workdir with full import closure.
 */
import { parseArgs } from "https://deno.land/std@0.224.0/cli/parse_args.ts";
import { join, dirname, relative, resolve, fromFileUrl } from "https://deno.land/std@0.224.0/path/mod.ts";
import { crypto } from "https://deno.land/std@0.224.0/crypto/mod.ts";

const REPO_ROOT = resolve(fromFileUrl(new URL(".", import.meta.url)), "..");
const IMPORT_RE = /(?:from|import)\s+["'](\.\.?\/[^"']+)["']/g;

async function* walk(root: string): AsyncGenerator<{ path: string; isFile: boolean }> {
  for await (const entry of Deno.readDir(root)) {
    if (entry.name === "node_modules" || entry.name === ".deno") continue;
    const path = join(root, entry.name);
    if (entry.isDirectory) yield* walk(path);
    else yield { path, isFile: true };
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function copyFile(src: string, dest: string) {
  await Deno.mkdir(dirname(dest), { recursive: true });
  await Deno.copyFile(src, dest);
}

function extractRelativeImports(source: string): string[] {
  const out = new Set<string>();
  for (const m of source.matchAll(IMPORT_RE)) out.add(m[1]);
  return [...out];
}

async function resolveImport(baseFile: string, spec: string): Promise<string | null> {
  const base = dirname(baseFile);
  let candidate = resolve(base, spec);
  if (await exists(candidate)) return candidate;
  if (await exists(`${candidate}.ts`)) return `${candidate}.ts`;
  if (await exists(join(candidate, "index.ts"))) return join(candidate, "index.ts");
  return null;
}

async function sha256Dir(dir: string): Promise<string> {
  const proc = new Deno.Command("tar", {
    args: ["-cf", "-", "-C", dir, "."],
    stdout: "piped",
  });
  const { stdout, code } = await proc.output();
  if (code !== 0) throw new Error(`tar failed for ${dir}`);
  const hash = await crypto.subtle.digest("SHA-256", stdout);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const args = parseArgs(Deno.args, {
  string: ["slug", "download-dir", "out-dir"],
});

const slug = args.slug;
if (!slug) {
  console.error("Missing --slug");
  Deno.exit(1);
}

const downloadDir = resolve(String(args["download-dir"]));
const outDir = resolve(String(args["out-dir"]));
const repoShared = join(REPO_ROOT, "supabase/functions/_shared");

const outFunctions = join(outDir, "supabase/functions");
const outShared = join(outFunctions, "_shared");
await Deno.mkdir(outShared, { recursive: true });

const downloadFunctions = join(downloadDir, "supabase/functions");
if (await exists(downloadFunctions)) {
  for await (const entry of walk(downloadFunctions)) {
    if (!entry.isFile) continue;
    const rel = relative(downloadFunctions, entry.path);
    await copyFile(entry.path, join(outFunctions, rel));
  }
}

const entrySrc = join(downloadFunctions, slug, "index.ts");
const entryDest = join(outFunctions, slug, "index.ts");
if (!(await exists(entrySrc))) {
  console.error(`Missing downloaded entrypoint: ${entrySrc}`);
  Deno.exit(1);
}
await copyFile(entrySrc, entryDest);

const queue: string[] = [entryDest];
const seen = new Set<string>();

while (queue.length) {
  const file = queue.shift()!;
  if (seen.has(file)) continue;
  seen.add(file);
  if (!(await exists(file))) continue;
  const source = await Deno.readTextFile(file);
  for (const spec of extractRelativeImports(source)) {
    if (!spec.startsWith("../") && !spec.startsWith("./")) continue;
    let resolved = await resolveImport(file, spec);
    if (!resolved) {
      const sharedRel = spec
        .replace(/^\.\.\/_shared\//, "")
        .replace(/^\.\.\/\.\.\/_shared\//, "")
        .replace(/^\.\//, "");
      const repoCandidate = join(repoShared, sharedRel);
      if (await exists(repoCandidate)) resolved = repoCandidate;
      else if (await exists(`${repoCandidate}.ts`)) resolved = `${repoCandidate}.ts`;
      else if (await exists(join(repoCandidate, "index.ts"))) resolved = join(repoCandidate, "index.ts");
    }
    if (!resolved) {
      console.warn(`UNRESOLVED: ${spec} from ${relative(outDir, file)}`);
      continue;
    }
    let normalizedDest: string;
    if (resolved.startsWith(repoShared)) {
      normalizedDest = resolve(join(outShared, relative(repoShared, resolved)));
    } else {
      normalizedDest = resolve(dirname(file), spec.endsWith(".ts") ? spec : `${spec}.ts`);
    }
    if (!(await exists(normalizedDest))) {
      await copyFile(resolved, normalizedDest);
    }
    queue.push(normalizedDest);
  }
}

const configToml = join(outDir, "supabase/config.toml");
if (!(await exists(configToml))) {
  await Deno.writeTextFile(configToml, 'project_id = "rollback-local"\n');
}
const denoJson = join(outFunctions, "deno.json");
if (!(await exists(denoJson))) {
  await Deno.writeTextFile(denoJson, JSON.stringify({ nodeModulesDir: "auto" }, null, 2));
}

const check = new Deno.Command("deno", {
  args: ["check", join(outFunctions, slug, "index.ts")],
  cwd: outDir,
  stdout: "piped",
  stderr: "piped",
});
const checkOut = await check.output();
const treeSha = await sha256Dir(outDir);

const manifest = {
  slug,
  workdir: outDir,
  tree_sha256: treeSha,
  import_files: seen.size,
  deno_check_ok: checkOut.code === 0,
  deno_check_stderr: checkOut.code === 0 ? null : new TextDecoder().decode(checkOut.stderr),
  rollback_command:
    `supabase functions deploy ${slug} --project-ref thazislrdkjpvvghtvzo --workdir ${outDir}`,
};

await Deno.writeTextFile(join(outDir, "MANIFEST.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify(manifest, null, 2));
if (!manifest.deno_check_ok) Deno.exit(1);
