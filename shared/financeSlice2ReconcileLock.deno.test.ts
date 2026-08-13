/**
 * Slice 2 lock — git-reconcile of prod-identical finalize + ops-p0 sources.
 * CW topup helpers intentionally excluded (local newer than deployed).
 *
 * Run: deno test --allow-read --no-check shared/financeSlice2ReconcileLock.deno.test.ts
 */
import { assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { dirname, fromFileUrl, join } from "https://deno.land/std@0.224.0/path/mod.ts";

const REPO_ROOT = join(dirname(fromFileUrl(import.meta.url)), "..");

Deno.test("finalize-trip-and-capture wires durable settlement + Revolut finalize", () => {
  const src = Deno.readTextFileSync(
    join(REPO_ROOT, "supabase/functions/finalize-trip-and-capture/index.ts"),
  );
  assert(src.includes("finalizeRevolutTripCapture"));
  assert(src.includes("durableSettlementColumns"));
  assert(src.includes("durableSettlementOutcomeSSOT.ts"));
});

Deno.test("ops-p0-release-duplicate-holds is cancel-only (no capture/paid invent)", () => {
  const src = Deno.readTextFileSync(
    join(REPO_ROOT, "supabase/functions/ops-p0-release-duplicate-holds/index.ts"),
  );
  assert(src.includes("cancelRevolutOrder"));
  assert(!src.includes("captureRevolutOrder"));
});
