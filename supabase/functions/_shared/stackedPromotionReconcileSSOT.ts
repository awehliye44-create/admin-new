/**
 * #54D — Backend-owned, bounded, idempotent stacked promotion reconciliation.
 * Recovers stranded queued bookings when Trip A completed but promote failed /
 * response was lost / Driver app died during handover.
 *
 * Does not invent business rules. Calls promote_stacked_trip only.
 * Clears stale stacked_trip_id pointers (#54E) without touching fare/financials.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  STACKED_RIDE_ORPHAN_PREVENTED,
  STACKED_RIDE_PROMOTED,
} from "./stackedRideLifecycle.ts";

export const STACKED_PROMOTION_RECONCILE = "STACKED_PROMOTION_RECONCILE";
export const STACKED_PROMOTION_FAILURE_ALERT = "STACKED_PROMOTION_FAILURE_ALERT";

export const STACKED_PROMOTE_RECONCILE_BATCH = 25;
/** Escalate to ops_alerts after this many consecutive failed promote attempts. */
export const STACKED_PROMOTE_FAILURE_ALERT_AFTER = 2;

export type StrandedQueuedCandidate = {
  queuedTripId: string;
  driverId: string;
  completedTripId: string | null;
  reason: "no_live_active" | "completed_parent_link";
};

export type StackedPromoteReconcileCounts = {
  examined: number;
  promoted: number;
  skipped: number;
  cleared_stale_links: number;
  alerted: number;
  errors: number;
};

type TripRow = {
  id: string;
  status: string;
  driver_id: string | null;
  confirmed_driver_id: string | null;
  stacked_trip_id: string | null;
  completed_at: string | null;
  updated_at: string | null;
};

function driverIdOf(row: {
  driver_id?: string | null;
  confirmed_driver_id?: string | null;
}): string | null {
  const d = typeof row.driver_id === "string" ? row.driver_id.trim() : "";
  if (d) return d;
  const c =
    typeof row.confirmed_driver_id === "string"
      ? row.confirmed_driver_id.trim()
      : "";
  return c || null;
}

/** Select stranded queued trips + completed parents still linking a queued child. */
export function selectStrandedStackedPromotionCandidates(input: {
  queued: TripRow[];
  liveActiveByDriver: Map<string, string[]>;
  completedParentsLinkingQueued: Array<{
    parentId: string;
    driverId: string | null;
    queuedId: string;
  }>;
}): StrandedQueuedCandidate[] {
  const out: StrandedQueuedCandidate[] = [];
  const seenQueued = new Set<string>();

  for (const parent of input.completedParentsLinkingQueued) {
    const driverId = parent.driverId;
    if (!driverId || !parent.queuedId) continue;
    const live = input.liveActiveByDriver.get(driverId) ?? [];
    if (live.length > 0) continue;
    seenQueued.add(parent.queuedId);
    out.push({
      queuedTripId: parent.queuedId,
      driverId,
      completedTripId: parent.parentId,
      reason: "completed_parent_link",
    });
  }

  for (const q of input.queued) {
    if (q.status !== "queued") continue;
    if (seenQueued.has(q.id)) continue;
    const driverId = driverIdOf(q);
    if (!driverId) continue;
    const live = input.liveActiveByDriver.get(driverId) ?? [];
    if (live.length > 0) continue;
    out.push({
      queuedTripId: q.id,
      driverId,
      completedTripId: null,
      reason: "no_live_active",
    });
  }

  return out;
}

export function buildStackedPromotionFailureAlertRow(input: {
  driverId: string;
  queuedTripId: string;
  completedTripId: string | null;
  detail: string;
  nowIso?: string;
}): Record<string, unknown> {
  const nowIso = input.nowIso ?? new Date().toISOString();
  const fingerprint = `stacked:promote_stranded:${input.queuedTripId}`;
  return {
    fingerprint,
    category: "stacked_promotion",
    severity: "warning",
    status: "open",
    source: "edge_function",
    app: "backend",
    title: "Stacked promotion stranded",
    description: `Queued trip ${input.queuedTripId} was not promoted after Trip A completed. ${input.detail}`.slice(
      0,
      500,
    ),
    related_entity_type: "trip",
    related_entity_id: input.queuedTripId,
    related_trip_id: input.queuedTripId,
    metadata: {
      driver_id: input.driverId,
      queued_trip_id: input.queuedTripId,
      completed_trip_id: input.completedTripId,
      detail: input.detail,
    },
    last_detected_at: nowIso,
    updated_at: nowIso,
  };
}

async function upsertPromoteFailureAlert(
  supabase: SupabaseClient,
  row: Record<string, unknown>,
): Promise<boolean> {
  try {
    const fingerprint = String(row.fingerprint ?? "");
    const { data: existing } = await supabase
      .from("ops_alerts")
      .select("id, fingerprint_count")
      .eq("fingerprint", fingerprint)
      .in("status", ["open", "acknowledged"])
      .maybeSingle();
    if (existing?.id) {
      const nextCount = Math.max(1, Number(existing.fingerprint_count) || 1) + 1;
      const { error } = await supabase
        .from("ops_alerts")
        .update({
          title: row.title,
          description: row.description,
          severity: row.severity,
          metadata: row.metadata,
          fingerprint_count: nextCount,
          last_detected_at: row.last_detected_at,
          updated_at: row.updated_at,
        })
        .eq("id", existing.id);
      return !error;
    }
    const { error } = await supabase.from("ops_alerts").insert(row);
    return !error;
  } catch {
    return false;
  }
}

/** Clear terminal parents whose stacked_trip_id no longer points at a queued child. */
export async function clearStaleStackedTripLinks(
  supabase: SupabaseClient,
  limit = STACKED_PROMOTE_RECONCILE_BATCH,
): Promise<number> {
  const { data: parents, error } = await supabase
    .from("trips")
    .select("id, stacked_trip_id, status")
    .not("stacked_trip_id", "is", null)
    .in("status", ["completed", "cancelled"])
    .limit(limit);
  if (error || !parents?.length) return 0;

  let cleared = 0;
  for (const parent of parents) {
    const childId =
      typeof parent.stacked_trip_id === "string" ? parent.stacked_trip_id : null;
    if (!childId) continue;
    const { data: child } = await supabase
      .from("trips")
      .select("id, status")
      .eq("id", childId)
      .maybeSingle();
    if (child && String(child.status) === "queued") continue;
    const { error: updErr } = await supabase
      .from("trips")
      .update({ stacked_trip_id: null, updated_at: new Date().toISOString() })
      .eq("id", parent.id)
      .eq("stacked_trip_id", childId);
    if (!updErr) {
      cleared += 1;
      console.log(STACKED_RIDE_ORPHAN_PREVENTED, {
        action: "clear_stale_stacked_link",
        parent_trip_id: parent.id,
        former_child_id: childId,
        child_status: child?.status ?? "missing",
      });
    }
  }
  return cleared;
}

/**
 * Idempotent promote attempt for one stranded candidate.
 * Concurrent callers are safe — promote_stacked_trip is atomic.
 */
export async function attemptStrandedStackedPromotion(
  supabase: SupabaseClient,
  candidate: StrandedQueuedCandidate,
): Promise<{
  promoted: boolean;
  skipped: boolean;
  detail: string;
  shouldAlert: boolean;
}> {
  // Re-check live active under race (queued cancel / concurrent promote).
  const { count: liveCount } = await supabase
    .from("trips")
    .select("id", { count: "exact", head: true })
    .or(
      `driver_id.eq.${candidate.driverId},confirmed_driver_id.eq.${candidate.driverId}`,
    )
    .in("status", [
      "accepted",
      "arrived",
      "arrived_at_pickup",
      "arrived_pickup",
      "at_pickup",
      "pickup_waiting",
      "waiting",
      "in_progress",
    ])
    .neq("id", candidate.queuedTripId);

  if ((liveCount ?? 0) > 0) {
    return {
      promoted: false,
      skipped: true,
      detail: "blocking_trip_exists",
      shouldAlert: false,
    };
  }

  const { data: queued } = await supabase
    .from("trips")
    .select("id, status")
    .eq("id", candidate.queuedTripId)
    .maybeSingle();
  if (!queued || String(queued.status) !== "queued") {
    return {
      promoted: false,
      skipped: true,
      detail: "queued_cancelled_or_missing",
      shouldAlert: false,
    };
  }

  const { data, error } = await supabase.rpc("promote_stacked_trip", {
    p_driver_id: candidate.driverId,
    p_completed_trip_id: candidate.completedTripId,
  });

  if (error) {
    console.log(STACKED_RIDE_ORPHAN_PREVENTED, {
      action: "reconcile_promote_error",
      queued_trip_id: candidate.queuedTripId,
      driver_id: candidate.driverId,
      completed_trip_id: candidate.completedTripId,
      error: error.message,
    });
    return {
      promoted: false,
      skipped: false,
      detail: error.message,
      shouldAlert: true,
    };
  }

  if (data?.promoted === true) {
    console.log(STACKED_RIDE_PROMOTED, {
      source: "reconcile_stranded_stacked",
      queued_trip_id: candidate.queuedTripId,
      driver_id: candidate.driverId,
      completed_trip_id: candidate.completedTripId,
      rpc_result: data,
    });
    return {
      promoted: true,
      skipped: false,
      detail: "promoted",
      shouldAlert: false,
    };
  }

  const reason = String(data?.reason ?? "not_promoted");
  return {
    promoted: false,
    skipped: reason === "no_stacked_trip" || reason === "blocking_trip_exists",
    detail: reason,
    shouldAlert: reason === "promotion_failed",
  };
}

/** Full bounded reconcile pass — safe for cron. */
export async function runStackedPromotionReconcilePass(
  supabase: SupabaseClient,
  options?: { limit?: number },
): Promise<StackedPromoteReconcileCounts> {
  const limit = Math.min(
    STACKED_PROMOTE_RECONCILE_BATCH,
    Math.max(1, options?.limit ?? STACKED_PROMOTE_RECONCILE_BATCH),
  );
  const counts: StackedPromoteReconcileCounts = {
    examined: 0,
    promoted: 0,
    skipped: 0,
    cleared_stale_links: 0,
    alerted: 0,
    errors: 0,
  };

  counts.cleared_stale_links = await clearStaleStackedTripLinks(supabase, limit);

  const { data: queuedRows, error: queuedErr } = await supabase
    .from("trips")
    .select(
      "id, status, driver_id, confirmed_driver_id, stacked_trip_id, completed_at, updated_at",
    )
    .eq("status", "queued")
    .order("updated_at", { ascending: true })
    .limit(limit);

  if (queuedErr) {
    counts.errors += 1;
    console.log(STACKED_PROMOTION_RECONCILE, {
      ok: false,
      error: queuedErr.message,
    });
    return counts;
  }

  const queued = (queuedRows ?? []) as TripRow[];
  const driverIds = [
    ...new Set(
      queued.map(driverIdOf).filter((id): id is string => Boolean(id)),
    ),
  ];

  const liveActiveByDriver = new Map<string, string[]>();
  if (driverIds.length > 0) {
    const { data: liveRows } = await supabase
      .from("trips")
      .select("id, driver_id, confirmed_driver_id, status")
      .or(
        driverIds
          .map((id) => `driver_id.eq.${id},confirmed_driver_id.eq.${id}`)
          .join(","),
      )
      .in("status", [
        "accepted",
        "arrived",
        "arrived_at_pickup",
        "arrived_pickup",
        "at_pickup",
        "pickup_waiting",
        "waiting",
        "in_progress",
      ]);
    for (const row of liveRows ?? []) {
      const d = driverIdOf(row as TripRow);
      if (!d) continue;
      const list = liveActiveByDriver.get(d) ?? [];
      list.push(String((row as { id: string }).id));
      liveActiveByDriver.set(d, list);
    }
  }

  const { data: parentLinks } = await supabase
    .from("trips")
    .select("id, driver_id, confirmed_driver_id, stacked_trip_id, status")
    .not("stacked_trip_id", "is", null)
    .eq("status", "completed")
    .limit(limit);

  const completedParentsLinkingQueued: Array<{
    parentId: string;
    driverId: string | null;
    queuedId: string;
  }> = [];
  for (const parent of parentLinks ?? []) {
    const queuedId =
      typeof parent.stacked_trip_id === "string" ? parent.stacked_trip_id : null;
    if (!queuedId) continue;
    const { data: child } = await supabase
      .from("trips")
      .select("id, status")
      .eq("id", queuedId)
      .maybeSingle();
    if (!child || String(child.status) !== "queued") continue;
    completedParentsLinkingQueued.push({
      parentId: String(parent.id),
      driverId: driverIdOf(parent as TripRow),
      queuedId,
    });
  }

  const candidates = selectStrandedStackedPromotionCandidates({
    queued,
    liveActiveByDriver,
    completedParentsLinkingQueued,
  }).slice(0, limit);

  counts.examined = candidates.length;

  for (const candidate of candidates) {
    try {
      const result = await attemptStrandedStackedPromotion(supabase, candidate);
      if (result.promoted) counts.promoted += 1;
      else if (result.skipped) counts.skipped += 1;
      else counts.errors += 1;

      if (result.shouldAlert) {
        const row = buildStackedPromotionFailureAlertRow({
          driverId: candidate.driverId,
          queuedTripId: candidate.queuedTripId,
          completedTripId: candidate.completedTripId,
          detail: result.detail,
        });
        const wrote = await upsertPromoteFailureAlert(supabase, row);
        if (wrote) {
          counts.alerted += 1;
          console.log(STACKED_PROMOTION_FAILURE_ALERT, {
            fingerprint: row.fingerprint,
            queued_trip_id: candidate.queuedTripId,
            driver_id: candidate.driverId,
          });
        }
      }
    } catch (e) {
      counts.errors += 1;
      console.log(STACKED_RIDE_ORPHAN_PREVENTED, {
        action: "reconcile_exception",
        queued_trip_id: candidate.queuedTripId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  console.log(STACKED_PROMOTION_RECONCILE, { ok: true, ...counts });
  return counts;
}
