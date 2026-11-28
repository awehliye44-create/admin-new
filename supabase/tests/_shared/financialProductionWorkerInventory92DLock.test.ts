/**
 * #92D — Permanent financial production worker inventory protection.
 *
 * Detects remote-only / undocumented CAPTURE·INCREMENT workers and cron consumers
 * by requiring local versioned source + documented responsibilities.
 * Does not deploy and does not enable Stage D.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const INV_URL = new URL(
  "../../../scripts/financial_production_worker_inventory.json",
  import.meta.url,
);

type Inventory = {
  class_a_capture_increment_hubs: string[];
  canonical_finalize_entrypoints: string[];
  financial_cron_consumers: Array<{ jobname: string; invokes: string }>;
  orphan_or_remote_only_watchlist: Array<{
    slug: string;
    must_have_local_entrypoint: boolean;
    capture_path: string;
  }>;
  retired_capture_entrypoints: string[];
};

async function loadInventory(): Promise<Inventory> {
  return JSON.parse(await Deno.readTextFile(INV_URL)) as Inventory;
}

function repoPath(rel: string): URL {
  return new URL(`../../../${rel}`, import.meta.url);
}

Deno.test("#92D inventory JSON is present and names CAPTURE/INCREMENT hubs", async () => {
  const inv = await loadInventory();
  assert(inv.class_a_capture_increment_hubs.length >= 4);
  assert(inv.canonical_finalize_entrypoints.includes("process-trip-capture-jobs"));
  assert(inv.canonical_finalize_entrypoints.includes("finalize-trip-and-capture"));
  assert(
    inv.financial_cron_consumers.some((c) =>
      c.jobname === "process-trip-capture-jobs-every-1-min"
    ),
  );
});

Deno.test("#92D process-trip-capture-jobs has local source and only invokes finalize", async () => {
  const entry = await Deno.readTextFile(
    repoPath("supabase/functions/process-trip-capture-jobs/index.ts"),
  );
  assert(entry.includes("claimTripCaptureJobs"));
  assert(entry.includes("processClaimedTripCaptureJob"));
  assertEquals(entry.includes("captureRevolutOrder"), false);
  assertEquals(entry.includes("incrementRevolutOrderAuthorisation"), false);
  assertEquals(entry.includes("/capture"), false);
  assertEquals(entry.includes("increment-authorisation"), false);

  const ssot = await Deno.readTextFile(
    repoPath("supabase/functions/process-trip-capture-jobs/lib/tripCaptureJobSSOT.ts"),
  );
  assert(ssot.includes("invokeFinalizeTripCapture"));
  assert(ssot.includes("finalize-trip-and-capture") || ssot.includes("invokeFinalizeTripCapture"));
  assertEquals(ssot.includes("captureRevolutOrder("), false);
  assertEquals(ssot.includes("incrementRevolutOrderAuthorisation"), false);
});

Deno.test("#92D invokeFinalizeTripCapture targets finalize-trip-and-capture only", async () => {
  const invoke = await Deno.readTextFile(
    repoPath("supabase/functions/_shared/invokeFinalizeTripCapture.ts"),
  );
  assert(invoke.includes("/functions/v1/finalize-trip-and-capture"));
  assertEquals(invoke.includes("captureRevolutOrder"), false);
  assertEquals(invoke.includes("increment-authorisation"), false);
});

Deno.test("#92D Class-A hubs remain fenced (no unprotected captureRevolutOrder await)", async () => {
  const inv = await loadInventory();
  for (const rel of inv.class_a_capture_increment_hubs) {
    const text = await Deno.readTextFile(repoPath(rel));
    if (rel.endsWith("guardedProviderCaptureSSOT.ts")) {
      assert(text.includes("claimFinancialOperationForPost"));
      assert(text.includes("captureRevolutOrder"));
      continue;
    }
    if (rel.endsWith("executeSameOrderIncrementSSOT.ts")) {
      assert(text.includes("claimFinancialOperationForPost"));
      assert(text.includes("incrementRevolutOrderAuthorisation"));
      continue;
    }
    assert(
      text.includes("guardedCaptureRevolutOrder") ||
        text.includes("claimFinancialOperationForPost"),
      rel,
    );
    assertEquals(text.includes("await captureRevolutOrder("), false, rel);
  }
});

Deno.test("#92D retired capture entrypoints stay disabled", async () => {
  const inv = await loadInventory();
  for (const slug of inv.retired_capture_entrypoints) {
    const text = await Deno.readTextFile(
      repoPath(`supabase/functions/${slug}/index.ts`),
    );
    assert(
      text.includes("legacyEdgeBlockedResponse") ||
        text.includes("LEGACY_CAPTURE_ENDPOINT_DISABLED") ||
        text.includes("disabled"),
      slug,
    );
  }
});

Deno.test("#92D watchlist orphans require local entrypoints", async () => {
  const inv = await loadInventory();
  for (const row of inv.orphan_or_remote_only_watchlist) {
    if (!row.must_have_local_entrypoint) continue;
    const path = repoPath(`supabase/functions/${row.slug}/index.ts`);
    await Deno.stat(path);
    assert(row.capture_path.toLowerCase().includes("finalize"));
  }
});

Deno.test("#92D financial cron consumers map to local Edge or SQL SSOT names", async () => {
  const inv = await loadInventory();
  for (const c of inv.financial_cron_consumers) {
    assert(c.jobname.length > 0);
    assert(c.invokes.length > 0);
    // Edge slug form — must exist locally when it is a function name.
    if (/^[a-z0-9-]+$/.test(c.invokes)) {
      await Deno.stat(repoPath(`supabase/functions/${c.invokes}/index.ts`));
    }
  }
});

Deno.test("#92E compare tool + inventory classify remote-only non-mutation workers", async () => {
  const inv = await loadInventory() as Inventory & {
    compare_tool?: string;
    remote_only_non_mutation_classified?: Array<{ slug: string }>;
  };
  assertEquals(inv.compare_tool, "scripts/compare-financial-edge-inventory.py");
  await Deno.stat(repoPath("scripts/compare-financial-edge-inventory.py"));
  const classified = inv.remote_only_non_mutation_classified ?? [];
  assert(classified.some((r) => r.slug === "corporate-trip-invoice"));
  assert(classified.some((r) => r.slug === "driver-passenger-fare-records"));
});

Deno.test("#92E process-trip-capture-jobs config disables JWT (cron/service-role auth instead)", async () => {
  const cfg = await Deno.readTextFile(repoPath("supabase/config.toml"));
  assert(cfg.includes("[functions.process-trip-capture-jobs]"));
  const idx = cfg.indexOf("[functions.process-trip-capture-jobs]");
  const slice = cfg.slice(idx, idx + 120);
  assert(slice.includes("verify_jwt = false"));
});
