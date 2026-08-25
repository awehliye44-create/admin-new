#!/usr/bin/env -S deno test --allow-read --allow-write --allow-run --allow-env
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { join } from "https://deno.land/std@0.224.0/path/mod.ts";

const REPO = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
const RECON = join(REPO, "step82a5-reconstruct-workdir.ts");

async function runReconstruct(args: string[]): Promise<{ code: number; stdout: string }> {
  const proc = new Deno.Command("deno", {
    args: ["run", "--allow-read", "--allow-write", "--allow-run", "--allow-env", RECON, ...args],
    stdout: "piped",
    stderr: "piped",
  });
  const out = await proc.output();
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr),
  };
}

Deno.test("type-only missing module is deploy-erased, not a value-import violation", async () => {
  const extract = join(REPO, "fixtures/step82a5/reconstruct-type-only-src");
  const out = await Deno.makeTempDir({ prefix: "step82a5-recon-" });
  const { code, stdout } = await runReconstruct([
    "--slug", "demo",
    "--version", "1",
    "--ezbr", "deadbeef",
    "--extract-dir", extract,
    "--out-dir", out,
  ]);
  assertEquals(code, 0, stdout);
  const manifest = JSON.parse(await Deno.readTextFile(join(out, "MANIFEST.json")));
  assertEquals(manifest.external_import_violations.length, 0);
  assertEquals(manifest.deploy_erased_type_imports.length, 1);
  assertEquals(manifest.deploy_erased_type_imports[0].specifier, "./missingTypeOnly.ts");
  assertEquals(manifest.deno_check_ok, true);
  assertEquals(manifest.deno_bundle_ok, true);
});

Deno.test("v447 preserved archive reconstructs with zero value-import violations", async () => {
  const archive = "/Users/admin/admin-new/.audit-step82a5-2026-08-19/archives/finalize-trip-and-capture-body.bin";
  const headers = "/Users/admin/admin-new/.audit-step82a5-2026-08-19/archives/finalize-trip-and-capture-response.headers";
  try {
    await Deno.stat(archive);
  } catch {
    return;
  }
  const extract = await Deno.makeTempDir({ prefix: "step82a5-v447-" });
  const extractProc = new Deno.Command("deno", {
    args: [
      "run", "--allow-read", "--allow-write", "--allow-run",
      join(REPO, "step82a5-safe-archive-extract.ts"),
      "--archive", archive,
      "--response-headers", headers,
      "--out", extract,
      "--slug", "finalize-trip-and-capture",
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const ex = await extractProc.output();
  assertEquals(ex.code, 0);

  const out = await Deno.makeTempDir({ prefix: "step82a5-v447-wd-" });
  const { code, stdout } = await runReconstruct([
    "--slug", "finalize-trip-and-capture",
    "--version", "447",
    "--ezbr", "4ac5fac294eaf3ca3a9e77ffdce541eccf25454d18b8e9d4fd271a8343f3a19d",
    "--extract-dir", extract,
    "--out-dir", out,
    "--archive", archive,
  ]);
  assertEquals(code, 0, stdout);
  const manifest = JSON.parse(await Deno.readTextFile(join(out, "MANIFEST.json")));
  assertEquals(manifest.deployed_file_count, 42);
  assertEquals(manifest.external_import_violations.length, 0);
  assertEquals(manifest.deploy_erased_type_imports.length, 1);
  assert(manifest.deploy_erased_type_imports[0].expected_path.includes("revolutCustomers.ts"));
  assertEquals(manifest.deno_check_ok, true);
  assertEquals(manifest.deno_bundle_ok, true);
});
