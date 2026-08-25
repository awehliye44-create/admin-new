#!/usr/bin/env -S deno run --allow-read --allow-run
import { parseArgs } from "https://deno.land/std@0.224.0/cli/parse_args.ts";
import { crypto } from "https://deno.land/std@0.224.0/crypto/mod.ts";
import { join, resolve, fromFileUrl } from "https://deno.land/std@0.224.0/path/mod.ts";

const args = parseArgs(Deno.args, { string: ["root"] });
const root = resolve(String(args.root));
const IMPORT_RE = /(?:from|import)\s+["']([^"']+)["']/g;

async function sha256Dir(dir: string): Promise<string> {
  const proc = new Deno.Command("tar", { args: ["-cf", "-", "-C", dir, "."], stdout: "piped" });
  const { stdout, code } = await proc.output();
  if (code !== 0) throw new Error(`tar failed ${dir}`);
  const hash = await crypto.subtle.digest("SHA-256", stdout);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function walkFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function w(d: string) {
    for await (const e of Deno.readDir(d)) {
      const p = join(d, e.name);
      if (e.isDirectory) await w(p);
      else out.push(p);
    }
  }
  await w(dir);
  return out;
}

const result: Record<string, unknown> = {};
for await (const e of Deno.readDir(root)) {
  if (!e.isDirectory) continue;
  const wd = join(root, e.name);
  const entry = join(wd, "supabase/functions", e.name, "index.ts");
  let imports: string[] = [];
  try {
    const src = await Deno.readTextFile(entry);
    imports = [...src.matchAll(IMPORT_RE)].map((m) => m[1]);
  } catch { /* */ }
  result[e.name] = {
    tree_sha256: await sha256Dir(wd),
    import_graph_entry: imports,
  };
}
console.log(JSON.stringify(result, null, 2));
