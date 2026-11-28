/**
 * #54D/#54E/#54F — stranded promote reconcile selection + concurrency fixtures.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildStackedPromotionFailureAlertRow,
  selectStrandedStackedPromotionCandidates,
  STACKED_PROMOTE_RECONCILE_BATCH,
} from "../../functions/reconcile-stranded-stacked-promotions/lib/stackedPromotionReconcileSSOT.ts";

Deno.test("selects queued with no live active as stranded", () => {
  const candidates = selectStrandedStackedPromotionCandidates({
    queued: [
      {
        id: "q1",
        status: "queued",
        driver_id: "d1",
        confirmed_driver_id: "d1",
        stacked_trip_id: null,
        completed_at: null,
        updated_at: null,
      },
    ],
    liveActiveByDriver: new Map(),
    completedParentsLinkingQueued: [],
  });
  assertEquals(candidates.length, 1);
  assertEquals(candidates[0]?.reason, "no_live_active");
  assertEquals(candidates[0]?.queuedTripId, "q1");
});

Deno.test("skips queued when driver still has live Trip A", () => {
  const candidates = selectStrandedStackedPromotionCandidates({
    queued: [
      {
        id: "q1",
        status: "queued",
        driver_id: "d1",
        confirmed_driver_id: "d1",
        stacked_trip_id: null,
        completed_at: null,
        updated_at: null,
      },
    ],
    liveActiveByDriver: new Map([["d1", ["a1"]]]),
    completedParentsLinkingQueued: [],
  });
  assertEquals(candidates.length, 0);
});

Deno.test("completed parent link yields stranded candidate once", () => {
  const candidates = selectStrandedStackedPromotionCandidates({
    queued: [
      {
        id: "q1",
        status: "queued",
        driver_id: "d1",
        confirmed_driver_id: "d1",
        stacked_trip_id: null,
        completed_at: null,
        updated_at: null,
      },
    ],
    liveActiveByDriver: new Map(),
    completedParentsLinkingQueued: [
      { parentId: "a1", driverId: "d1", queuedId: "q1" },
    ],
  });
  assertEquals(candidates.length, 1);
  assertEquals(candidates[0]?.reason, "completed_parent_link");
  assertEquals(candidates[0]?.completedTripId, "a1");
});

Deno.test("ops alert fingerprint is stable per queued trip", () => {
  const row = buildStackedPromotionFailureAlertRow({
    driverId: "d1",
    queuedTripId: "q1",
    completedTripId: "a1",
    detail: "promotion_failed",
    nowIso: "2026-11-20T00:00:00.000Z",
  });
  assertEquals(row.fingerprint, "stacked:promote_stranded:q1");
  assertEquals(row.category, "stacked_promotion");
  assertEquals(row.status, "open");
});

Deno.test("reconcile batch bound is finite and edge function is wired", async () => {
  assertEquals(STACKED_PROMOTE_RECONCILE_BATCH > 0, true);
  assertEquals(STACKED_PROMOTE_RECONCILE_BATCH <= 50, true);
  const edge = await Deno.readTextFile(
    new URL(
      "../../functions/reconcile-stranded-stacked-promotions/index.ts",
      import.meta.url,
    ),
  );
  assertEquals(edge.includes("runStackedPromotionReconcilePass"), true);
  assertEquals(edge.includes("assertCronOrServiceRoleAuth"), true);

  const cron = await Deno.readTextFile(
    new URL(
      "../../migrations/20270227140100_stacked_promote_reconcile_cron.sql",
      import.meta.url,
    ),
  );
  assertEquals(cron.includes("reconcile-stranded-stacked-promotions"), true);
});

/** #54F deterministic concurrency fixtures (non-billable). */
Deno.test("#54F duplicate stranded candidates collapse to one promote target", () => {
  const candidates = selectStrandedStackedPromotionCandidates({
    queued: [
      {
        id: "q1",
        status: "queued",
        driver_id: "d1",
        confirmed_driver_id: "d1",
        stacked_trip_id: null,
        completed_at: null,
        updated_at: null,
      },
      {
        id: "q1",
        status: "queued",
        driver_id: "d1",
        confirmed_driver_id: "d1",
        stacked_trip_id: null,
        completed_at: null,
        updated_at: null,
      },
    ],
    liveActiveByDriver: new Map(),
    completedParentsLinkingQueued: [
      { parentId: "a1", driverId: "d1", queuedId: "q1" },
    ],
  });
  // Parent-link path wins first; queued loop skips seenQueued.
  assertEquals(candidates.length, 1);
});

Deno.test("#54F cancellation of queued during selection is skipped via status filter", () => {
  const candidates = selectStrandedStackedPromotionCandidates({
    queued: [
      {
        id: "q1",
        status: "cancelled",
        driver_id: "d1",
        confirmed_driver_id: "d1",
        stacked_trip_id: null,
        completed_at: null,
        updated_at: null,
      },
    ],
    liveActiveByDriver: new Map(),
    completedParentsLinkingQueued: [],
  });
  assertEquals(candidates.length, 0);
});
