/**
 * #110 P4B / #94A — missing-PENDING recovery contract (source lock).
 *
 * Production MK-261126-006/007: complete HTTP 500 before PENDING; tip skip + TEN
 * ~20s later. sweep-revolut-stale-holds runs every 5 minutes and skips when TEN
 * already exists — not evidence the recovery worker itself failed.
 *
 * Run: deno test --allow-read --no-check supabase/tests/_shared/completeTripP4BRecovery94aLock.test.ts
 */
import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

Deno.test("#94A recovery skips when TEN exists; awaits capture only", async () => {
  const recovery = await Deno.readTextFile(
    new URL(
      "../../functions/_shared/missingTripEarningPendingRecoverySSOT.ts",
      import.meta.url,
    ),
  );
  assertStringIncludes(recovery, 'status: "TEN_EXISTS"');
  assertStringIncludes(recovery, "PENDING_RECOVERY_AWAITING_CAPTURE_STATUSES");
  assertStringIncludes(recovery, "Never posts TEN");
  assertEquals(recovery.includes("creditTripEarningPending"), true);
});

Deno.test("#94A sweep hosts missing-PENDING recovery (not tip-window length)", async () => {
  const sweep = await Deno.readTextFile(
    new URL("../../functions/sweep-revolut-stale-holds/index.ts", import.meta.url),
  );
  assertStringIncludes(sweep, "missing_pending_recovery_98");
  assertStringIncludes(sweep, "recoverMissingTripEarningPendingBatch");
});

Deno.test("#113/#98 stop-workflow no longer best-effort PENDING", async () => {
  const stop = await Deno.readTextFile(
    new URL("../../functions/stop-workflow/index.ts", import.meta.url),
  );
  assertStringIncludes(stop, "PENDING_ENTITLEMENT_FAILED");
  assertEquals(stop.includes("Never block Complete→Rate"), false);
  assertStringIncludes(stop, "logTipWindowTenDeferred");
});
