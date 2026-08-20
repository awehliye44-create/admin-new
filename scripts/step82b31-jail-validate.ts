#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run --allow-env
/**
 * Step 8.2B3.1 — filesystem-jail bundle validation for a forward workdir.
 */
import { parseArgs } from "https://deno.land/std@0.224.0/cli/parse_args.ts";
import { crypto } from "https://deno.land/std@0.224.0/crypto/mod.ts";
import { join, resolve } from "https://deno.land/std@0.224.0/path/mod.ts";

export type JailValidationResult = {
  slug: string;
  jail_root: string;
  isolated_root: string;
  cache_ok: boolean;
  bundle_ok: boolean;
  check_ok: boolean | null;
  bundle_sha256: string | null;
  failed_to_read_warnings: number;
  repo_path_leaks: string[];
  stderr_excerpt: string;
};

const REPO_ROOT = resolve(new URL(".", import.meta.url).pathname, "..");

function scanForLeaks(text: string, repoRoot: string): string[] {
  const leaks: string[] = [];
  const normRepo = repoRoot.replaceAll("\\", "/");
  for (const line of text.split("\n")) {
    if (line.includes(normRepo) && !line.includes("/.audit-step82b31")) {
      leaks.push(line.trim().slice(0, 200));
    }
    if (/failed to read file/i.test(line)) leaks.push(line.trim().slice(0, 200));
  }
  return leaks;
}

export async function validateInJail(args: {
  slug: string;
  workdir: string;
  jailParent?: string;
}): Promise<JailValidationResult> {
  const { slug, workdir } = args;
  const jailRoot = args.jailParent ??
    await Deno.makeTempDir({ prefix: "step82b31-jail-" });
  const isolatedRoot = join(jailRoot, "isolated");

  // Ensure jail parent has no repo supabase/shared folders
  await Deno.mkdir(isolatedRoot, { recursive: true });

  const copyProc = new Deno.Command("cp", {
    args: ["-R", workdir + "/.", isolatedRoot],
    stdout: "piped",
    stderr: "piped",
  });
  const cpOut = await copyProc.output();
  if (cpOut.code !== 0) {
    throw new Error(`cp to jail failed: ${new TextDecoder().decode(cpOut.stderr)}`);
  }

  const entry = `supabase/functions/${slug}/index.ts`;
  const bundleOut = join(isolatedRoot, ".jail-bundle.js");
  let combinedStderr = "";

  const cacheProc = new Deno.Command("deno", {
    args: ["cache", "--no-check", entry],
    cwd: isolatedRoot,
    stdout: "piped",
    stderr: "piped",
  });
  const cacheOut = await cacheProc.output();
  combinedStderr += new TextDecoder().decode(cacheOut.stderr);
  const cacheOk = cacheOut.code === 0;

  const bundleProc = new Deno.Command("deno", {
    args: ["bundle", entry],
    cwd: isolatedRoot,
    stdout: "piped",
    stderr: "piped",
  });
  const bundleRun = await bundleProc.output();
  combinedStderr += "\n" + new TextDecoder().decode(bundleRun.stderr);
  const bundleOk = bundleRun.code === 0;
  let bundleSha: string | null = null;
  if (bundleOk) {
    await Deno.writeFile(bundleOut, bundleRun.stdout);
    const hash = await crypto.subtle.digest("SHA-256", bundleRun.stdout);
    bundleSha = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  const checkProc = new Deno.Command("deno", {
    args: ["check", entry],
    cwd: isolatedRoot,
    stdout: "piped",
    stderr: "piped",
  });
  const checkOut = await checkProc.output();
  combinedStderr += "\n" + new TextDecoder().decode(checkOut.stderr);
  const checkOk = checkOut.code === 0;

  const failedToRead = (combinedStderr.match(/failed to read file/gi) ?? []).length;
  const repoLeaks = scanForLeaks(combinedStderr, REPO_ROOT);

  return {
    slug,
    jail_root: jailRoot,
    isolated_root: isolatedRoot,
    cache_ok: cacheOk,
    bundle_ok: bundleOk,
    check_ok: checkOk,
    bundle_sha256: bundleSha,
    failed_to_read_warnings: failedToRead,
    repo_path_leaks: repoLeaks,
    stderr_excerpt: combinedStderr.slice(0, 8000),
  };
}

export function jailPass(r: JailValidationResult): boolean {
  return r.cache_ok && r.bundle_ok && r.failed_to_read_warnings === 0 && r.repo_path_leaks.length === 0;
}

if (import.meta.main) {
  const args = parseArgs(Deno.args, { string: ["slug", "workdir"] });
  const slug = String(args.slug ?? "");
  const workdir = resolve(String(args.workdir ?? ""));
  if (!slug || !workdir) {
    console.error("Usage: --slug SLUG --workdir PATH");
    Deno.exit(1);
  }
  const result = await validateInJail({ slug, workdir });
  console.log(JSON.stringify(result, null, 2));
  Deno.exit(jailPass(result) ? 0 : 1);
}
