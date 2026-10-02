/**
 * Phase 4 — sweep_expired_offers: mark stale offers expired and queue next auto-dispatch wave.
 * Used by expire-offers cron. Pure helpers mirrored in src/lib/sweepExpiredOffers.ts for Vitest.
 */

export const OFFER_EXPIRED_TRIGGER_REASON = "offer_expired" as const;
export const STALE_TRIP_SCAN_TRIGGER_REASON = "stale_trip_no_pending" as const;
export const SEARCH_WINDOW_RECHECK_TRIGGER_REASON = "search_window_recheck" as const;

/** expire-offers stale scan requires dispatch_status=broadcasting (not searching). */
export const STALE_TRIP_REBROADCAST_DISPATCH_STATUS = "broadcasting" as const;

export type StaleTripRebroadcastCandidate = {
  dispatch_status: string | null;
  current_broadcast_round: number | null;
  max_broadcast_rounds: number | null;
  pending_offer_count: number;
};

/**
 * After NO_DRIVERS_WAIT_NEXT_ROUND (round < max), keep dispatch_status=broadcasting so
 * expire-offers stale scan can invoke auto-dispatch with force_rebroadcast.
 */
export function dispatchStatusAfterNoDriversWaitNextRound(
  currentRound: number,
  maxRounds: number,
): typeof STALE_TRIP_REBROADCAST_DISPATCH_STATUS | "searching" {
  return currentRound < maxRounds
    ? STALE_TRIP_REBROADCAST_DISPATCH_STATUS
    : "searching";
}

/**
 * Default max absolute sequences when trip stamp is missing.
 * Admin Max Dispatch Rounds default 3 cycles × 3 waves = 9 sequences.
 */
export const DEFAULT_MAX_BROADCAST_SEQUENCES = 9;

/** Predicate mirrored by expire-offers stale trip rebroadcast scan. */
export function isStaleTripRebroadcastCandidate(
  trip: StaleTripRebroadcastCandidate,
): boolean {
  const currentRound = trip.current_broadcast_round ?? 0;
  const maxRounds = trip.max_broadcast_rounds ?? DEFAULT_MAX_BROADCAST_SEQUENCES;
  return (
    trip.dispatch_status === STALE_TRIP_REBROADCAST_DISPATCH_STATUS
    && trip.pending_offer_count === 0
    && currentRound > 0
    && currentRound < maxRounds
  );
}
export const VEHICLE_TYPE_SELECTED_STUCK_TRIGGER_REASON =
  "vehicle_type_selected_stuck_recovery" as const;

/** Dispatch audit events that prove the pipeline progressed past vehicle selection. */
export const DISPATCH_PROGRESS_EVENT_TYPES = [
  "dispatch_config_snapshot",
  "dispatch_wave_trace",
  "offers_inserted",
  "push_sent",
] as const;

export type ExpireStaleOffersResult = {
  expired_count: number;
  trips_needing_rebroadcast: string[];
};

export type OfferExpiredRebroadcastBody = {
  trip_id: string;
  force_rebroadcast: true;
  trigger_reason: typeof OFFER_EXPIRED_TRIGGER_REASON;
  reason_for_next_wave: typeof OFFER_EXPIRED_TRIGGER_REASON;
};

export type StaleTripScanRebroadcastBody = {
  trip_id: string;
  force_rebroadcast: true;
  trigger_reason: typeof STALE_TRIP_SCAN_TRIGGER_REASON;
  reason_for_next_wave?: null;
};

export type SearchWindowRecheckRebroadcastBody = {
  trip_id: string;
  force_rebroadcast: true;
  trigger_reason: typeof SEARCH_WINDOW_RECHECK_TRIGGER_REASON;
  reason_for_next_wave: typeof SEARCH_WINDOW_RECHECK_TRIGGER_REASON;
};

export type VehicleTypeSelectedStuckRebroadcastBody = {
  trip_id: string;
  force_rebroadcast: true;
  trigger_reason: typeof VEHICLE_TYPE_SELECTED_STUCK_TRIGGER_REASON;
  reason_for_next_wave: typeof VEHICLE_TYPE_SELECTED_STUCK_TRIGGER_REASON;
};

export type RebroadcastInvocation =
  | { tripId: string; body: OfferExpiredRebroadcastBody }
  | { tripId: string; body: StaleTripScanRebroadcastBody }
  | { tripId: string; body: SearchWindowRecheckRebroadcastBody }
  | { tripId: string; body: VehicleTypeSelectedStuckRebroadcastBody };

export function buildOfferExpiredRebroadcastBody(tripId: string): OfferExpiredRebroadcastBody {
  return {
    trip_id: tripId,
    force_rebroadcast: true,
    trigger_reason: OFFER_EXPIRED_TRIGGER_REASON,
    reason_for_next_wave: OFFER_EXPIRED_TRIGGER_REASON,
  };
}

export function buildStaleTripScanRebroadcastBody(tripId: string): StaleTripScanRebroadcastBody {
  return {
    trip_id: tripId,
    force_rebroadcast: true,
    trigger_reason: STALE_TRIP_SCAN_TRIGGER_REASON,
    reason_for_next_wave: null,
  };
}

export function buildSearchWindowRecheckRebroadcastBody(
  tripId: string,
): SearchWindowRecheckRebroadcastBody {
  return {
    trip_id: tripId,
    force_rebroadcast: true,
    trigger_reason: SEARCH_WINDOW_RECHECK_TRIGGER_REASON,
    reason_for_next_wave: SEARCH_WINDOW_RECHECK_TRIGGER_REASON,
  };
}

export function buildVehicleTypeSelectedStuckRebroadcastBody(
  tripId: string,
): VehicleTypeSelectedStuckRebroadcastBody {
  return {
    trip_id: tripId,
    force_rebroadcast: true,
    trigger_reason: VEHICLE_TYPE_SELECTED_STUCK_TRIGGER_REASON,
    reason_for_next_wave: VEHICLE_TYPE_SELECTED_STUCK_TRIGGER_REASON,
  };
}

/** Pure filter: trip stuck when audit never progressed past vehicle_type_selected. */
export function filterStuckVehicleTypeSelectedTripIds(input: {
  tripIds: string[];
  pendingOfferCountByTripId: ReadonlyMap<string, number>;
  auditEventTypesByTripId: ReadonlyMap<string, readonly string[]>;
}): string[] {
  const stuck: string[] = [];
  for (const tripId of dedupeTripIdsForRebroadcast(input.tripIds)) {
    if ((input.pendingOfferCountByTripId.get(tripId) ?? 0) > 0) continue;

    const events = input.auditEventTypesByTripId.get(tripId) ?? [];
    if (!events.includes("vehicle_type_selected")) continue;
    if (events.some((eventType) => DISPATCH_PROGRESS_EVENT_TYPES.includes(
      eventType as (typeof DISPATCH_PROGRESS_EVENT_TYPES)[number],
    ))) {
      continue;
    }

    const latest = events[0];
    if (latest === "vehicle_type_selected" || latest === "dispatch_aborted") {
      stuck.push(tripId);
    }
  }
  return stuck;
}

export function buildVehicleTypeSelectedStuckInvocations(
  tripIds: string[],
): Array<{ tripId: string; body: VehicleTypeSelectedStuckRebroadcastBody }> {
  return dedupeTripIdsForRebroadcast(tripIds).map((tripId) => ({
    tripId,
    body: buildVehicleTypeSelectedStuckRebroadcastBody(tripId),
  }));
}

type TripRow = { id: string };
type AuditRow = { trip_id: string; event_type: string; created_at?: string };

/**
 * Recovery sweep: trips in round 0 with no offers whose dispatch audit stopped at
 * vehicle_type_selected (MK-260528-031). Re-invokes auto-dispatch automatically.
 */
export async function findStuckVehicleTypeSelectedTrips(
  supabase: {
    from: (table: string) => {
      select: (columns: string) => {
        in: (column: string, values: string[]) => {
          eq: (column: string, value: number | boolean) => {
            gte: (
              column: string,
              value: string,
            ) => PromiseLike<{ data: TripRow[] | null; error: unknown }>;
          };
        };
        eq: (column: string, value: string) => {
          eq: (column: string, value: string) => {
            select: (
              columns: string,
              options?: { count?: "exact"; head?: boolean },
            ) => PromiseLike<{ count: number | null; error: unknown }>;
          };
          order: (
            column: string,
            options: { ascending: boolean },
          ) => {
            limit: (n: number) => PromiseLike<{ data: AuditRow[] | null; error: unknown }>;
          };
        };
      };
    };
  },
  options: { lookbackHours?: number; maxCandidates?: number } = {},
): Promise<string[]> {
  const lookbackHours = options.lookbackHours ?? 6;
  const maxCandidates = options.maxCandidates ?? 25;
  const cutoff = new Date(Date.now() - lookbackHours * 60 * 60 * 1000).toISOString();

  // Scan & Go retired (trips.scan_go dropped 20260903121500) — do not filter on it.
  const { data: candidates, error: tripsError } = await supabase
    .from("trips")
    .select("id")
    .in("status", ["searching", "broadcasting"])
    .eq("current_broadcast_round", 0)
    .gte("created_at", cutoff);

  if (tripsError || !candidates?.length) {
    if (tripsError) {
      console.warn("[sweepExpiredOffers] stuck trip candidate query failed:", tripsError);
    }
    return [];
  }

  const tripIds = candidates.slice(0, maxCandidates).map((row) => row.id);
  const pendingOfferCountByTripId = new Map<string, number>();
  const auditEventTypesByTripId = new Map<string, string[]>();

  for (const tripId of tripIds) {
    const { count, error: offerErr } = await supabase
      .from("ride_offers")
      .select("id", { count: "exact", head: true })
      .eq("trip_id", tripId)
      .eq("status", "pending");
    if (offerErr) {
      console.warn("[sweepExpiredOffers] pending offer check failed", tripId, offerErr);
      continue;
    }
    pendingOfferCountByTripId.set(tripId, count ?? 0);

    const { data: audits, error: auditErr } = await supabase
      .from("dispatch_audit_log")
      .select("trip_id, event_type, created_at")
      .eq("trip_id", tripId)
      .order("created_at", { ascending: false })
      .limit(12);
    if (auditErr) {
      console.warn("[sweepExpiredOffers] dispatch audit query failed", tripId, auditErr);
      continue;
    }
    auditEventTypesByTripId.set(
      tripId,
      (audits ?? []).map((row) => row.event_type),
    );
  }

  return filterStuckVehicleTypeSelectedTripIds({
    tripIds,
    pendingOfferCountByTripId,
    auditEventTypesByTripId,
  });
}

export function dedupeTripIdsForRebroadcast(tripIds: Iterable<string>): string[] {
  return [...new Set(tripIds)];
}

/** One auto-dispatch invoke per trip; offer_expired > stale scan > search-window recheck. */
export function buildRebroadcastInvocations(
  offerExpiredTripIds: string[],
  staleScanTripIds: string[],
  searchWindowRecheckTripIds: string[] = [],
): RebroadcastInvocation[] {
  const offerExpiredSet = new Set(dedupeTripIdsForRebroadcast(offerExpiredTripIds));
  const staleScanSet = new Set(dedupeTripIdsForRebroadcast(staleScanTripIds));
  const invocations: RebroadcastInvocation[] = [];

  for (const tripId of offerExpiredSet) {
    invocations.push({ tripId, body: buildOfferExpiredRebroadcastBody(tripId) });
  }

  for (const tripId of staleScanSet) {
    if (!offerExpiredSet.has(tripId)) {
      invocations.push({ tripId, body: buildStaleTripScanRebroadcastBody(tripId) });
    }
  }

  const covered = new Set([...offerExpiredSet, ...staleScanSet]);
  for (const tripId of dedupeTripIdsForRebroadcast(searchWindowRecheckTripIds)) {
    if (!covered.has(tripId)) {
      invocations.push({ tripId, body: buildSearchWindowRecheckRebroadcastBody(tripId) });
    }
  }

  return invocations;
}

/** Rollback: set DISPATCH_OFFER_EXPIRY_WAVE_ENABLED=false to skip expiry-driven rebroadcast. */
export function isOfferExpiryWaveEnabled(): boolean {
  const raw = Deno.env.get("DISPATCH_OFFER_EXPIRY_WAVE_ENABLED");
  if (raw === undefined || raw === "") return true;
  return !["0", "false", "no", "off"].includes(raw.toLowerCase());
}

type SupabaseRpcClient = {
  rpc: (fn: string, args?: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;
};

/** RPC may list trips from partial wave expiry; edge rebroadcast requires zero pending offers. */
export async function filterTripIdsWithNoPendingOffers(
  supabase: {
    from: (table: string) => {
      select: (
        columns: string,
        options?: { count?: "exact"; head?: boolean },
      ) => {
        eq: (column: string, value: string) => {
          eq: (column: string, value: string) => PromiseLike<{ count: number | null; error: unknown }>;
        };
      };
    };
  },
  tripIds: string[],
): Promise<string[]> {
  const ready: string[] = [];
  for (const tripId of dedupeTripIdsForRebroadcast(tripIds)) {
    const { count, error } = await supabase
      .from("ride_offers")
      .select("id", { count: "exact", head: true })
      .eq("trip_id", tripId)
      .eq("status", "pending");
    if (error) {
      console.warn("[sweepExpiredOffers] pending check failed", tripId, error);
      continue;
    }
    if ((count ?? 0) === 0) {
      ready.push(tripId);
    }
  }
  return ready;
}

/**
 * Mark pending offers past expires_at as expired via expire_stale_offers RPC.
 * Returns trip IDs needing rebroadcast (deduped by SQL).
 */
export async function sweepExpiredOffers(
  supabase: SupabaseRpcClient,
): Promise<
  | { ok: true; result: ExpireStaleOffersResult }
  | { ok: false; error: string }
> {
  const { data, error } = await supabase.rpc("expire_stale_offers");

  if (error) {
    const message = typeof error === "object" && error !== null && "message" in error
      ? String((error as { message: unknown }).message)
      : String(error);
    return { ok: false, error: message };
  }

  const payload = (data ?? {}) as Record<string, unknown>;
  const expiredCount = typeof payload.expired_count === "number" ? payload.expired_count : 0;
  const rawTrips = Array.isArray(payload.trips_needing_rebroadcast)
    ? payload.trips_needing_rebroadcast
    : [];

  const tripsNeedingRebroadcast = dedupeTripIdsForRebroadcast(
    rawTrips.filter((id): id is string => typeof id === "string"),
  );

  return {
    ok: true,
    result: {
      expired_count: expiredCount,
      trips_needing_rebroadcast: tripsNeedingRebroadcast,
    },
  };
}
