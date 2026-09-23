/**
 * Admin HELD release actions — Assign / Make Available / Broadcast Now|At.
 * One pending action per trip. T−urgent convert must clear pending first.
 *
 * Make Available in Scheduled Jobs ≠ Broadcast:
 * - Make Available → publish for advance PRE-CONFIRMATION (Scheduled Jobs list)
 * - Broadcast → open NRO / auto-dispatch path now (or At via pending_release)
 */

export const PENDING_RELEASE_KINDS = ["assign", "broadcast", "jobs"] as const;
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
 * Make Available in Scheduled Jobs — leave Admin HELD and publish for advance
 * PRE-CONFIRMATION only. Does NOT start NRO / auto-dispatch.
 * Visibility: scheduled_broadcast_at due + scheduled_marketplace_is_open.
 */
export function buildMakeAvailableScheduledJobsPatch(input: {
  nowIso: string;
}): Record<string, unknown> {
  return {
    scheduled_status: "scheduled",
    status: "scheduled",
    scheduled_broadcast_at: input.nowIso,
    dispatch_mode: "scheduled",
    ...clearPendingReleasePatch(),
  };
}

/**
 * Broadcast Now — leave HELD (or release preconfirm) and start the existing
 * NRO / auto-dispatch path. Distinct from Make Available (Scheduled Jobs).
 * Always clears confirmed_driver_id so Broadcast can recover after a drop-out.
 */
export function buildBroadcastNowPatch(input: { nowIso: string }): Record<string, unknown> {
  return {
    scheduled_status: "broadcasting",
    status: "offered",
    scheduled_broadcast_at: input.nowIso,
    dispatch_mode: "scheduled",
    confirmed_driver_id: null,
    ...clearPendingReleasePatch(),
  };
}

export function isPendingReleaseDue(input: {
  pending_release_kind: string | null | undefined;
  pending_release_at: string | null | undefined;
  nowMs: number;
}): boolean {
  const kind = String(input.pending_release_kind ?? "").trim().toLowerCase();
  if (kind !== "assign" && kind !== "broadcast" && kind !== "jobs") return false;
  const at = input.pending_release_at
    ? Date.parse(input.pending_release_at)
    : NaN;
  return Number.isFinite(at) && input.nowMs >= at;
}
