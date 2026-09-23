/**
 * Admin HELD release SSOT lock.
 * Run: deno test --allow-read supabase/tests/_shared/scheduledAdminReleaseLock.test.ts
 */
import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildAssignNowPatch,
  buildBroadcastNowPatch,
  buildPendingReleasePatch,
  clearPendingReleasePatch,
  isPendingReleaseDue,
} from "../../functions/_shared/scheduledAdminReleaseSSOT.ts";
import { buildScheduledUrgentConversionPatch } from "../../functions/_shared/scheduledDispatchConfig.ts";

Deno.test("Assign Now clears pending and pre-confirms", () => {
  const patch = buildAssignNowPatch({
    driverId: "drv-1",
    nowIso: "2026-09-21T12:00:00.000Z",
  });
  assertEquals(patch.confirmed_driver_id, "drv-1");
  assertEquals(patch.scheduled_status, "driver_assigned");
  assertEquals(patch.status, "scheduled");
  assertEquals(patch.driver_id, null);
  assertEquals(patch.pending_release_kind, null);
});

Deno.test("Make Available publishes Scheduled Jobs without NRO", async () => {
  const { buildMakeAvailableScheduledJobsPatch } = await import(
    "../../functions/_shared/scheduledAdminReleaseSSOT.ts"
  );
  const patch = buildMakeAvailableScheduledJobsPatch({
    nowIso: "2026-09-21T12:00:00.000Z",
  });
  assertEquals(patch.scheduled_status, "scheduled");
  assertEquals(patch.status, "scheduled");
  assertEquals(patch.scheduled_broadcast_at, "2026-09-21T12:00:00.000Z");
  assertEquals(patch.pending_release_kind, null);
});

Deno.test("Broadcast Now starts NRO path (not Scheduled Jobs-only)", () => {
  const patch = buildBroadcastNowPatch({ nowIso: "2026-09-21T12:00:00.000Z" });
  assertEquals(patch.scheduled_status, "broadcasting");
  assertEquals(patch.status, "offered");
  assertEquals(patch.scheduled_broadcast_at, "2026-09-21T12:00:00.000Z");
  assertEquals(patch.pending_release_kind, null);
});

Deno.test("one pending action replaces prior via single column set", () => {
  const a = buildPendingReleasePatch({
    kind: "assign",
    executeAtIso: "2026-09-21T13:00:00.000Z",
    driverId: "drv-1",
  });
  const b = buildPendingReleasePatch({
    kind: "broadcast",
    executeAtIso: "2026-09-21T13:30:00.000Z",
  });
  const c = buildPendingReleasePatch({
    kind: "jobs",
    executeAtIso: "2026-09-21T13:45:00.000Z",
  });
  assertEquals(a.pending_release_kind, "assign");
  assertEquals(b.pending_release_kind, "broadcast");
  assertEquals(c.pending_release_kind, "jobs");
  assertEquals(b.pending_release_driver_id, null);
  assertEquals(c.pending_release_driver_id, null);
  assertEquals(clearPendingReleasePatch().pending_release_kind, null);
});

Deno.test("jobs pending is due with same boundary rules", () => {
  assertEquals(
    isPendingReleaseDue({
      pending_release_kind: "jobs",
      pending_release_at: "2026-09-21T13:00:00.000Z",
      nowMs: Date.parse("2026-09-21T13:00:00.000Z"),
    }),
    true,
  );
});

Deno.test("pending due boundary", () => {
  assertEquals(
    isPendingReleaseDue({
      pending_release_kind: "broadcast",
      pending_release_at: "2026-09-21T13:00:00.000Z",
      nowMs: Date.parse("2026-09-21T13:00:00.000Z"),
    }),
    true,
  );
  assertEquals(
    isPendingReleaseDue({
      pending_release_kind: "broadcast",
      pending_release_at: "2026-09-21T13:00:00.000Z",
      nowMs: Date.parse("2026-09-21T12:59:59.000Z"),
    }),
    false,
  );
});

Deno.test("T−urgent convert clears pending Assign At / Broadcast At", () => {
  const patch = buildScheduledUrgentConversionPatch({
    nowIso: "2026-09-21T13:51:00.000Z",
    searchingExpiresAtIso: "2026-09-21T13:57:00.000Z",
  });
  assertEquals(patch.pending_release_kind, null);
  assertEquals(patch.pending_release_at, null);
  assertEquals(patch.pending_release_driver_id, null);
});

Deno.test("scheduled-dispatch Step 0 executes pending releases", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/scheduled-dispatch/index.ts", import.meta.url),
  );
  assertStringIncludes(src, "STEP 0: ADMIN PENDING RELEASE");
  assertStringIncludes(src, "buildAssignNowPatch");
  assertStringIncludes(src, "buildBroadcastNowPatch");
  assertStringIncludes(src, "buildMakeAvailableScheduledJobsPatch");
  assertStringIncludes(src, 'kind === "jobs"');
  assertStringIncludes(src, "admin_pending_jobs_executed");
  assertStringIncludes(src, '.in("scheduled_status", ["admin_held", "scheduled", "broadcasting", "pending"])');
  assertStringIncludes(src, '.in("scheduled_status", ["admin_held", "scheduled", "pending"])');
});
