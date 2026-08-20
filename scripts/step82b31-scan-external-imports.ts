#!/usr/bin/env -S deno run --allow-read
/**
 * Verify zero local imports resolve outside each forward workdir.
 */
import { parseArgs } from "https://deno.land/std@0.224.0/cli/parse_args.ts";
import { join, resolve, relative } from "https://deno.land/std@0.224.0/path/mod.ts";

const LOCAL_SPEC_RE =
  /(?:import\s*(?:type\s*)?(?:[\w$*\s{},]*\sfrom\s*)?|export\s+(?:type\s+)?(?:\*|\{[^}]*\})\s+from\s+|import\s*\(\s*)["'](\.\.?\/[^"']+)["']/g;

const args = parseArgs(Deno.args, { string: ["root"] });
const root = resolve(String(args.root));

async function exists(p: string) {
  try {
    await Deno.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function resolveLocal(baseFile: string, spec: string): Promise<string | null> {
  const base = baseFile.slice(0, baseFile.lastIndexOf("/"));
  let c = `${base}/${spec}`.replace(/\/+/g, "/").replace(/\/\.\//g, "/");
  // normalize ../
  const parts = c.split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (p === "..") out.pop();
    else if (p !== "." && p !== "") out.push(p);
  }
  c = out.join("/");
  if (baseFile.startsWith("/") && !c.startsWith("/")) {
    c = `/${c}`;
  }
  if (await exists(c)) return c;
  if (await exists(`${c}.ts`)) return `${c}.ts`;
  return null;
}

const report: Record<string, unknown> = {};

for await (const e of Deno.readDir(root)) {
  if (!e.isDirectory) continue;
  const wd = join(root, e.name);
  const violations: string[] = [];
  async function walk(dir: string) {
    for await (const f of Deno.readDir(dir)) {
      const p = join(dir, f.name);
      if (f.isDirectory) await walk(p);
      else if (f.name.endsWith(".ts")) {
        const src = await Deno.readTextFile(p);
        for (const m of src.matchAll(LOCAL_SPEC_RE)) {
          const spec = m[1];
          if (spec.startsWith("http") || spec.startsWith("npm:")) continue;
          const resolved = await resolveLocal(p, spec);
          if (!resolved) {
            violations.push(`${relative(wd, p)} -> UNRESOLVED ${spec}`);
          } else if (!resolved.startsWith(wd)) {
            violations.push(`${relative(wd, p)} -> OUTSIDE ${spec} => ${resolved}`);
          }
        }
      }
    }
  }
  await walk(wd);
  report[e.name] = { violations: violations.length, details: violations.slice(0, 20) };
}

console.log(JSON.stringify(report, null, 2));
const total = Object.values(report).reduce(
  (n, v) => n + (v as { violations: number }).violations,
  0,
);
if (total > 0) Deno.exit(1);
