/**
 * Admin HELD release actions — Assign/Broadcast Now|At.
 * One pending action per trip. T−urgent convert must clear pending first.
 */

export const PENDING_RELEASE_KINDS = ["assign", "broadcast"] as const;
export type PendingReleaseKind = (typeof PENDING_RELEASE_KINDS)[number];

export type PendingReleaseClearPatch = {
  pending_release_kind: null;
  pending_release_at: null;
  pending_release_driver_id: null;
};

export function clearPendingReleasePatch(): PendingReleaseClearPatch {
  return {
    pending_release_kind: null,
    pending_release_at: null,
    pending_release_driver_id: null,
  };
}

export function buildPendingReleasePatch(input: {
  kind: PendingReleaseKind;
  executeAtIso: string;
  driverId?: string | null;
}): {
  pending_release_kind: PendingReleaseKind;
  pending_release_at: string;
  pending_release_driver_id: string | null;
} {
  return {
    pending_release_kind: input.kind,
    pending_release_at: input.executeAtIso,
    pending_release_driver_id:
      input.kind === "assign" && input.driverId
        ? String(input.driverId).trim()
        : null,
  };
}

/** Assign Now — pre-confirm driver; leave trip scheduled (not live). */
export function buildAssignNowPatch(input: {
  driverId: string;
  nowIso: string;
}): Record<string, unknown> {
  return {
    confirmed_driver_id: input.driverId,
    scheduled_status: "driver_assigned",
    scheduled_accepted_at: input.nowIso,
    // Keep list-only trip status — do not flip into live searching/en_route.
    status: "scheduled",
    // Never stamp live driver_id on pre-confirm — activation NRO Accept does that.
    driver_id: null,
    ...clearPendingReleasePatch(),
  };
}

/**
 * Broadcast Now — leave Admin HELD, open marketplace via broadcast_at=now
 * and scheduled_status=scheduled so scheduled-dispatch Step 2 / auto-dispatch
 * can run. Does not invent a second dispatch engine.
 */
export function buildBroadcastNowPatch(input: { nowIso: string }): Record<string, unknown> {
  return {
    scheduled_status: "scheduled",
    scheduled_broadcast_at: input.nowIso,
    dispatch_mode: "scheduled",
    ...clearPendingReleasePatch(),
  };
}

export function isPendingReleaseDue(input: {
  pending_release_kind: string | null | undefined;
  pending_release_at: string | null | undefined;
  nowMs: number;
}): boolean {
  const kind = String(input.pending_release_kind ?? "").trim().toLowerCase();
  if (kind !== "assign" && kind !== "broadcast") return false;
  const at = input.pending_release_at
    ? Date.parse(input.pending_release_at)
    : NaN;
  return Number.isFinite(at) && input.nowMs >= at;
}
