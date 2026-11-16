/**
 * Authoritative Live Trip ETA resolution — presentation only.
 * Reuses existing trip_route_cache / last_eta_* — never calls Google or Mapbox.
 */

export type LiveTripEtaLeg = "driver_to_pickup" | "pickup_to_dropoff";

export type LiveTripEtaResolution = {
  etaMinutes: number | null;
  /** True when an ETA value is present and considered current. */
  fresh: boolean;
  /** Display when ETA is unavailable / expired cache. */
  etaLabel: string | null;
  source: "override" | "route_cache" | "last_eta" | "unavailable";
  leg: LiveTripEtaLeg | null;
};

export function resolveLiveTripEtaLeg(lifecycleStage: string): LiveTripEtaLeg | null {
  switch (lifecycleStage) {
    case "driver_assigned":
    case "heading_to_pickup":
      return "driver_to_pickup";
    case "trip_started":
    case "intermediate_stop":
      return "pickup_to_dropoff";
    case "at_pickup":
    case "finding_driver":
    case "finding_new_driver":
    case "ended":
    default:
      return null;
  }
}

function readNumber(raw: unknown): number | null {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

function remainingMinutesFromEtaAt(etaAt: string | null | undefined, nowMs: number): number | null {
  if (!etaAt) return null;
  const etaMs = Date.parse(etaAt);
  if (!Number.isFinite(etaMs)) return null;
  return Math.max(0, Math.ceil((etaMs - nowMs) / 60_000));
}

function decayLastEtaMinutes(
  lastEtaMinutes: number | null | undefined,
  lastEtaCalculatedAt: string | null | undefined,
  nowMs: number,
): number | null {
  const base = readNumber(lastEtaMinutes);
  if (base == null) return null;
  if (!lastEtaCalculatedAt) return Math.max(0, Math.round(base));
  const calculatedMs = Date.parse(lastEtaCalculatedAt);
  if (!Number.isFinite(calculatedMs)) return Math.max(0, Math.round(base));
  const elapsedMin = Math.max(0, (nowMs - calculatedMs) / 60_000);
  return Math.max(0, Math.ceil(base - elapsedMin));
}

function formatEtaLabel(etaMinutes: number | null, fresh: boolean): string | null {
  if (etaMinutes == null) return fresh ? null : "Updating…";
  if (!fresh) return "Updating…";
  if (etaMinutes <= 0) return "<1 min";
  return `${Math.round(etaMinutes)} min`;
}

/**
 * Resolve ETA for Live Trip presentation without issuing new routing requests.
 */
export function resolveAuthoritativeLiveTripEta(args: {
  lifecycleStage: string;
  showDriver: boolean;
  nowMs?: number;
  /** Explicit publish override (Customer tick / lifecycle). */
  etaOverrideMinutes?: number | null;
  /** Existing trip_route_cache row for the selected leg (may be expired). */
  cachedRoute?: {
    duration_min?: number | null;
    eta_at?: string | null;
    expires_at?: string | null;
    cached_at?: string | null;
  } | null;
  lastEtaMinutes?: number | null;
  lastEtaCalculatedAt?: string | null;
}): LiveTripEtaResolution {
  const nowMs = args.nowMs ?? Date.now();
  const leg = args.showDriver ? resolveLiveTripEtaLeg(args.lifecycleStage) : null;

  if (!args.showDriver || leg == null) {
    return {
      etaMinutes: null,
      fresh: true,
      etaLabel: null,
      source: "unavailable",
      leg: null,
    };
  }

  const override = readNumber(args.etaOverrideMinutes ?? null);
  if (override != null) {
    const etaMinutes = Math.max(0, Math.round(override));
    return {
      etaMinutes,
      fresh: true,
      etaLabel: formatEtaLabel(etaMinutes, true),
      source: "override",
      leg,
    };
  }

  const cached = args.cachedRoute ?? null;
  if (cached) {
    const fromEtaAt = remainingMinutesFromEtaAt(cached.eta_at, nowMs);
    const fromDuration = readNumber(cached.duration_min);
    const expiresMs = cached.expires_at ? Date.parse(cached.expires_at) : NaN;
    const cacheFresh = Number.isFinite(expiresMs) ? expiresMs > nowMs : true;
    const etaMinutes =
      fromEtaAt != null
        ? fromEtaAt
        : fromDuration != null
        ? Math.max(0, Math.round(fromDuration))
        : null;
    if (etaMinutes != null) {
      return {
        etaMinutes,
        fresh: cacheFresh,
        etaLabel: formatEtaLabel(etaMinutes, cacheFresh),
        source: "route_cache",
        leg,
      };
    }
  }

  const decayed = decayLastEtaMinutes(
    args.lastEtaMinutes,
    args.lastEtaCalculatedAt,
    nowMs,
  );
  if (decayed != null) {
    const calculatedMs = args.lastEtaCalculatedAt
      ? Date.parse(args.lastEtaCalculatedAt)
      : NaN;
    const ageMs = Number.isFinite(calculatedMs) ? nowMs - calculatedMs : 0;
    const fresh = ageMs <= 90_000;
    return {
      etaMinutes: decayed,
      fresh,
      etaLabel: formatEtaLabel(decayed, fresh),
      source: "last_eta",
      leg,
    };
  }

  return {
    etaMinutes: null,
    fresh: false,
    etaLabel: "Updating…",
    source: "unavailable",
    leg,
  };
}

/** Export peek helper contract for route cache readers (no Google). */
export async function peekTripRouteCacheLeg(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  tripId: string,
  leg: LiveTripEtaLeg,
): Promise<{
  duration_min: number | null;
  eta_at: string | null;
  expires_at: string | null;
  cached_at: string | null;
} | null> {
  const { data } = await supabase
    .from("trip_route_cache")
    .select("duration_min, eta_at, expires_at, cached_at")
    .eq("trip_id", tripId)
    .eq("leg", leg)
    .maybeSingle();
  if (!data) return null;
  return {
    duration_min: readNumber(data.duration_min),
    eta_at: typeof data.eta_at === "string" ? data.eta_at : null,
    expires_at: typeof data.expires_at === "string" ? data.expires_at : null,
    cached_at: typeof data.cached_at === "string" ? data.cached_at : null,
  };
}
