#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run --allow-env
/**
 * Reconstruct standalone rollback workdir from deployed archive extract ONLY.
 */
import { parseArgs } from "https://deno.land/std@0.224.0/cli/parse_args.ts";
import { crypto } from "https://deno.land/std@0.224.0/crypto/mod.ts";
import { dirname, join, relative, resolve } from "https://deno.land/std@0.224.0/path/mod.ts";

const VALUE_IMPORT_RE =
  /(?:import\s+(?!type\s)(?:[\w*\s{},]*\sfrom\s)?|export\s+(?!type\s)(?:[\w*\s{},]*\sfrom\s)?)['"](\.\.?\/[^"']+)['"]/g;
const TYPE_ONLY_IMPORT_RE =
  /import\s+type\s+(?:[\w*\s{},]*\sfrom\s)?['"](\.\.?\/[^"']+)['"]/g;

const args = parseArgs(Deno.args, {
  string: ["slug", "version", "ezbr", "extract-dir", "out-dir", "archive"],
  boolean: ["strict-deno-check"],
  default: { "strict-deno-check": false },
});

const slug = String(args.slug);
const version = Number(args.version);
const ezbr = String(args.ezbr);
const extractDir = resolve(String(args["extract-dir"]));
const outDir = resolve(String(args["out-dir"]));
const strictDenoCheck = Boolean(args["strict-deno-check"]);

type FileRecord = {
  archive_path: string;
  reconstructed_path: string;
  sha256: string;
};

type DeployErasedTypeImport = {
  specifier: string;
  from: string;
  expected_path: string;
  in_archive: false;
  reason: "type_only_not_in_deployed_module_count";
};

async function exists(p: string) {
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

async function copyFile(src: string, dest: string) {
  await Deno.mkdir(dirname(dest), { recursive: true });
  await Deno.copyFile(src, dest);
}

async function walkFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string) {
    for await (const e of Deno.readDir(dir)) {
      const p = join(dir, e.name);
      if (e.isSymlink) throw new Error(`REJECT symlink in archive extract: ${p}`);
      if (e.isDirectory) await walk(p);
      else if (e.isFile) out.push(p);
      else throw new Error(`REJECT non-file entry: ${p}`);
    }
  }
  await walk(root);
  return out;
}

function extractRelativeImports(source: string): { value: string[]; typeOnly: string[] } {
  const value = new Set<string>();
  const typeOnly = new Set<string>();
  for (const m of source.matchAll(TYPE_ONLY_IMPORT_RE)) typeOnly.add(m[1]);
  for (const m of source.matchAll(VALUE_IMPORT_RE)) {
    if (!typeOnly.has(m[1])) value.add(m[1]);
  }
  return { value: [...value], typeOnly: [...typeOnly] };
}

async function resolveImport(baseFile: string, spec: string): Promise<string | null> {
  const base = dirname(baseFile);
  let c = resolve(base, spec);
  if (await exists(c)) return c;
  if (await exists(`${c}.ts`)) return `${c}.ts`;
  if (await exists(join(c, "index.ts"))) return join(c, "index.ts");
  return null;
}

function expectedWorkdirPath(outDir: string, baseFile: string, spec: string): string {
  const base = dirname(baseFile);
  let c = resolve(base, spec);
  if (!c.endsWith(".ts")) c = `${c}.ts`;
  return c;
}

function archiveRelativeFromWorkdir(outDir: string, filePath: string): string | null {
  const rel = relative(outDir, filePath);
  if (rel.startsWith("supabase/") || rel.startsWith("shared/")) return `source/${rel}`;
  return null;
}

async function readArchiveModuleCount(archivePath: string | undefined): Promise<number | null> {
  if (!archivePath) return null;
  try {
    const bytes = await Deno.readFile(archivePath);
    const raw = new TextDecoder().decode(bytes);
    const m = raw.match(/\{"deployment_id"[\s\S]*?"module_count"\s*:\s*(\d+)/);
    if (m) return Number(m[1]);
  } catch {
    /* optional */
  }
  return null;
}

if (!(await exists(extractDir))) {
  console.error(`Missing --extract-dir: ${extractDir}`);
  Deno.exit(1);
}

const records: FileRecord[] = [];
const pathMap: Record<string, string> = {};
const externalViolations: string[] = [];
const deployErasedTypeImports: DeployErasedTypeImport[] = [];
const archiveRelPaths = new Set<string>();

await Deno.mkdir(outDir, { recursive: true });

for (const src of await walkFiles(extractDir)) {
  const rel = relative(extractDir, src);
  const dest = join(outDir, rel);
  await copyFile(src, dest);
  const archivePath = rel.startsWith("supabase/") || rel.startsWith("shared/")
    ? `source/${rel}`
    : rel;
  records.push({
    archive_path: archivePath,
    reconstructed_path: dest,
    sha256: await sha256File(dest),
  });
  pathMap[archivePath] = rel;
  archiveRelPaths.add(archivePath);
}

const moduleCount = await readArchiveModuleCount(args.archive as string | undefined);

const configToml = join(outDir, "supabase/config.toml");
if (!(await exists(configToml))) {
  await Deno.writeTextFile(configToml, 'project_id = "rollback-local"\n');
}
const denoJson = join(outDir, "supabase/functions/deno.json");
if (!(await exists(denoJson))) {
  await Deno.writeTextFile(denoJson, JSON.stringify({ nodeModulesDir: "auto" }, null, 2) + "\n");
}
const packageJson = join(outDir, "package.json");
if (!(await exists(packageJson))) {
  await Deno.writeTextFile(
    packageJson,
    JSON.stringify({ name: `rollback-${slug}-v${version}`, private: true }, null, 2) + "\n",
  );
}

const entry = join(outDir, "supabase/functions", slug, "index.ts");
if (!(await exists(entry))) {
  console.error(`Missing entrypoint after reconstruct: ${entry}`);
  Deno.exit(1);
}

const queue = [entry];
const seen = new Set<string>();
const importGraph: Record<string, { value: string[]; typeOnly: string[] }> = {};

while (queue.length) {
  const file = queue.shift()!;
  if (seen.has(file)) continue;
  seen.add(file);
  if (!(await exists(file))) continue;
  const source = await Deno.readTextFile(file);
  const relFile = relative(outDir, file);
  const specs = extractRelativeImports(source);
  importGraph[relFile] = specs;

  for (const spec of specs.value) {
    const resolved = await resolveImport(file, spec);
    if (!resolved) {
      externalViolations.push(`${spec} from ${relFile}`);
      continue;
    }
    if (!resolved.startsWith(outDir)) {
      externalViolations.push(`external ${resolved} (${spec} from ${relFile})`);
      continue;
    }
    queue.push(resolved);
  }

  for (const spec of specs.typeOnly) {
    const resolved = await resolveImport(file, spec);
    if (resolved) {
      if (!resolved.startsWith(outDir)) {
        externalViolations.push(`external ${resolved} (${spec} from ${relFile})`);
        continue;
      }
      queue.push(resolved);
      continue;
    }
    const expected = expectedWorkdirPath(outDir, file, spec);
    const archiveCandidate = archiveRelativeFromWorkdir(outDir, expected);
    const inArchive = archiveCandidate ? archiveRelPaths.has(archiveCandidate) : false;
    if (!inArchive) {
      deployErasedTypeImports.push({
        specifier: spec,
        from: relFile,
        expected_path: relative(outDir, expected),
        in_archive: false,
        reason: "type_only_not_in_deployed_module_count",
      });
    }
  }
}

const denoCacheDir = join(outDir, ".deno-check-cache");
const denoEnv = { ...Deno.env.toObject(), DENO_DIR: denoCacheDir };

const cacheCmd = new Deno.Command("deno", {
  args: ["cache", "--no-check", entry],
  cwd: outDir,
  env: denoEnv,
  stdout: "piped",
  stderr: "piped",
});
const cacheOut = await cacheCmd.output();

const bundlePath = join(outDir, ".rollback-bundle.js");
const bundleCmd = new Deno.Command("deno", {
  args: ["bundle", entry],
  cwd: outDir,
  env: denoEnv,
  stdout: "piped",
  stderr: "piped",
});
const bundleOut = await bundleCmd.output();
if (bundleOut.code === 0) {
  await Deno.writeFile(bundlePath, bundleOut.stdout);
}

const checkArgs = strictDenoCheck ? ["check", entry] : ["cache", "--no-check", entry];
const check = new Deno.Command("deno", {
  args: checkArgs,
  cwd: outDir,
  env: denoEnv,
  stdout: "piped",
  stderr: "piped",
});
const checkOut = await check.output();

const layoutOk = (await exists(configToml)) &&
  (await exists(entry)) &&
  (await exists(join(outDir, "supabase/functions")));

const treeSha = await sha256Dir(outDir);

const manifest = {
  slug,
  version,
  ezbr_sha256: ezbr,
  workdir: outDir,
  tree_sha256: treeSha,
  archive_module_count: moduleCount,
  deployed_file_count: records.length,
  deno_check_ok: checkOut.code === 0 && externalViolations.length === 0 && layoutOk &&
    cacheOut.code === 0 && bundleOut.code === 0,
  deno_check_mode: strictDenoCheck ? "strict_check" : "deploy_parity_cache_no_check",
  deno_check_stderr: checkOut.code === 0 ? null : new TextDecoder().decode(checkOut.stderr),
  deno_cache_no_check_ok: cacheOut.code === 0,
  deno_bundle_ok: bundleOut.code === 0,
  boot_import_ok: cacheOut.code === 0 && bundleOut.code === 0,
  layout_ok: layoutOk,
  external_import_violations: externalViolations,
  deploy_erased_type_imports: deployErasedTypeImports,
  import_graph: importGraph,
  archive_to_workdir_map: pathMap,
  file_records: records,
  rollback_command: `supabase functions deploy ${slug} --project-ref thazislrdkjpvvghtvzo --workdir ${outDir}`,
};

await Deno.writeTextFile(join(outDir, "MANIFEST.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify({
  slug,
  tree_sha256: treeSha,
  deno_check_ok: manifest.deno_check_ok,
  deno_cache_no_check_ok: manifest.deno_cache_no_check_ok,
  deno_bundle_ok: manifest.deno_bundle_ok,
  violations: externalViolations.length,
  deploy_erased_type_imports: deployErasedTypeImports.length,
  files: records.length,
}, null, 2));

if (externalViolations.length > 0 || !manifest.deno_check_ok) Deno.exit(1);
