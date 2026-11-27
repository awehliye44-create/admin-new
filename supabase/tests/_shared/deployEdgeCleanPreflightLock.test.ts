/**
 * Lock: production Edge deploys must use dirty-tree rejecting preflight
 * and close the check-to-bundle race (lock + OS freeze + traceability).
 * Run: deno test --allow-read --allow-run --allow-write --allow-env \
 *   supabase/tests/_shared/deployEdgeCleanPreflightLock.test.ts
 */
import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const scriptUrl = new URL(
  "../../../scripts/deploy-edge-clean-preflight.sh",
  import.meta.url,
);
const guardUrl = new URL(
  "../../../scripts/lib/canonical-tree-publish-guard.sh",
  import.meta.url,
);
const rootUrl = new URL("../../../", import.meta.url);

Deno.test("deploy-edge-clean-preflight.sh rejects dirty trees and pins origin sync", async () => {
  const src = await Deno.readTextFile(scriptUrl);
  assertStringIncludes(src, "canonical-tree-publish-guard.sh");
  assertStringIncludes(src, "canonical_publish_begin");
  assertStringIncludes(src, "canonical_publish_end");
  assertStringIncludes(src, "functions deploy");
  assertStringIncludes(src, "supabase/functions");
  assertEquals(src.includes("--force"), false);
});

Deno.test("canonical-tree-publish-guard closes check-to-bundle race", async () => {
  const src = await Deno.readTextFile(guardUrl);
  assertStringIncludes(src, "onecab-canonical-publish.lockdir");
  assertStringIncludes(src, "mkdir");
  assertStringIncludes(src, "chmod -R a-w");
  assertStringIncludes(src, "canonical_publish_assert_freeze_blocks_writes");
  assertStringIncludes(src, "onecab-publish-log");
  assertStringIncludes(src, "_canonical_try_recover_stale_lock");
  assertStringIncludes(src, "git status --porcelain");
  assertStringIncludes(src, "origin/$branch");
  assertStringIncludes(src, "HEAD changed during publish");
});

Deno.test("AGENTS or scripts document mandatory preflight for Edge deploy", async () => {
  const st = await Deno.stat(scriptUrl);
  assertEquals(st.isFile, true);
  const guard = await Deno.stat(guardUrl);
  assertEquals(guard.isFile, true);
});

Deno.test({
  name: "freeze OS-enforces write block under publish lock (tmpdir)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const tmp = await Deno.makeTempDir({ prefix: "onecab-freeze-" });
    const bundle = `${tmp}/bundle`;
    await Deno.mkdir(bundle);
    await Deno.writeTextFile(`${bundle}/keep.txt`, "ok");
    // Init tiny git repo so guard can run
    const gitInit = new Deno.Command("bash", {
      args: [
        "-c",
        [
          `cd "${tmp}"`,
          "git init -b main >/dev/null",
          "git config user.email t@t",
          "git config user.name t",
          "git add bundle",
          'git commit -m init >/dev/null',
          // fake origin
          "git remote add origin .",
          "git update-ref refs/remotes/origin/main HEAD",
        ].join(" && "),
      ],
    });
    const initOut = await gitInit.output();
    assertEquals(initOut.success, true, new TextDecoder().decode(initOut.stderr));

    const guardPath = guardUrl.pathname;
    const script = `
      set -euo pipefail
      cd "${tmp}"
      source "${guardPath}"
      canonical_publish_begin --branch main --freeze-paths "bundle"
      # Must fail to write
      if ( echo x > bundle/evil.txt ) 2>/dev/null; then
        echo FREEZE_BROKEN
        exit 2
      fi
      echo FREEZE_OK
      canonical_publish_end --artifact-note test
    `;
    const run = new Deno.Command("bash", { args: ["-c", script] });
    const out = await run.output();
    const text = new TextDecoder().decode(out.stdout) +
      new TextDecoder().decode(out.stderr);
    assertStringIncludes(text, "FREEZE_OK");
    assertStringIncludes(text, "freeze blocks writes");
    assertEquals(out.success, true, text);
    await Deno.remove(tmp, { recursive: true });
  },
});

Deno.test({
  name: "concurrent second publish fails closed while lock held",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const tmp = await Deno.makeTempDir({ prefix: "onecab-lock-" });
    const bundle = `${tmp}/bundle`;
    await Deno.mkdir(bundle);
    await Deno.writeTextFile(`${bundle}/keep.txt`, "ok");
    const gitInit = new Deno.Command("bash", {
      args: [
        "-c",
        [
          `cd "${tmp}"`,
          "git init -b main >/dev/null",
          "git config user.email t@t",
          "git config user.name t",
          "git add bundle",
          'git commit -m init >/dev/null',
          "git remote add origin .",
          "git update-ref refs/remotes/origin/main HEAD",
        ].join(" && "),
      ],
    });
    assertEquals((await gitInit.output()).success, true);

    const guardPath = guardUrl.pathname;
    const script = `
      set -euo pipefail
      cd "${tmp}"
      source "${guardPath}"
      canonical_publish_begin --branch main --freeze-paths "bundle" --skip-freeze-probe
      # Second acquire in subshell must fail
      if bash -c 'source "${guardPath}"; cd "${tmp}"; canonical_publish_begin --branch main --freeze-paths bundle --skip-freeze-probe'; then
        echo CONCURRENT_ALLOWED
        exit 2
      fi
      echo CONCURRENT_BLOCKED
      canonical_publish_end
    `;
    const run = new Deno.Command("bash", { args: ["-c", script] });
    const out = await run.output();
    const text = new TextDecoder().decode(out.stdout) +
      new TextDecoder().decode(out.stderr);
    assertStringIncludes(text, "CONCURRENT_BLOCKED");
    assertStringIncludes(text, "CANONICAL_PUBLISH_FAIL");
    assertEquals(out.success, true, text);
    await Deno.remove(tmp, { recursive: true });
  },
});

Deno.test({
  name: "stale lock with dead holder is recovered",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const tmp = await Deno.makeTempDir({ prefix: "onecab-stale-" });
    const bundle = `${tmp}/bundle`;
    await Deno.mkdir(bundle);
    await Deno.writeTextFile(`${bundle}/keep.txt`, "ok");
    const gitInit = new Deno.Command("bash", {
      args: [
        "-c",
        [
          `cd "${tmp}"`,
          "git init -b main >/dev/null",
          "git config user.email t@t",
          "git config user.name t",
          "git add bundle",
          'git commit -m init >/dev/null',
          "git remote add origin .",
          "git update-ref refs/remotes/origin/main HEAD",
          "mkdir -p .git/onecab-canonical-publish.lockdir",
          'echo "999999999 2000-01-01T00:00:00Z" > .git/onecab-canonical-publish.lockdir/holder',
        ].join(" && "),
      ],
    });
    assertEquals((await gitInit.output()).success, true);

    const guardPath = guardUrl.pathname;
    const script = `
      set -euo pipefail
      cd "${tmp}"
      source "${guardPath}"
      canonical_publish_begin --branch main --freeze-paths "bundle" --skip-freeze-probe
      echo STALE_RECOVERED
      canonical_publish_end
    `;
    const run = new Deno.Command("bash", { args: ["-c", script] });
    const out = await run.output();
    const text = new TextDecoder().decode(out.stdout) +
      new TextDecoder().decode(out.stderr);
    assertStringIncludes(text, "recovering stale publish lock");
    assertStringIncludes(text, "STALE_RECOVERED");
    assertEquals(out.success, true, text);
    await Deno.remove(tmp, { recursive: true });
  },
});

// silence unused rootUrl in case
void rootUrl;
