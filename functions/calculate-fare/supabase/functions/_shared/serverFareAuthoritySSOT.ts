/**
 * Server-authoritative fare chain SSOT.
 *
 *   calculate-route → route_quote_artifacts   (Mapbox distance / duration, server SA)
 *   calculate-fare  → server_fare_quotes      (pricing-engine.ts only)
 *   booking quote   → booking_payment_quotes.server_fare_quote_id
 *   create-preauth  → payment_sessions.fare_snapshot built from server values
 *
 * The Customer app may transport opaque artifact ids. It is never
 * authoritative for distance, fare, buffer, service area, voucher or discount.
 *
 * Lock: serverFareAuthorityLock.test.ts — if it fails, fix the code.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";

export const SERVER_FARE_ARTIFACT_SCHEMA_VERSION = 1;
export const SERVER_FARE_ENGINE = "pricing-engine.ts";
export const ROUTE_ARTIFACT_PROVIDER = "mapbox_directions";
/** Choose Ride can sit on a priced route; Book must not lose its artifact. */
export const ROUTE_ARTIFACT_TTL_MS = 60 * 60_000;
export const FARE_ARTIFACT_TTL_MS = 60 * 60_000;

export const FARE_QUOTE_UNAVAILABLE = "FARE_QUOTE_UNAVAILABLE" as const;
export const SERVICE_AREA_MISMATCH = "SERVICE_AREA_MISMATCH" as const;
export const ROUTE_QUOTE_MISMATCH = "ROUTE_QUOTE_MISMATCH" as const;

export type LatLngInput = { lat?: unknown; lng?: unknown } | null | undefined;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v.trim());
}

function routeKeyCoord(v: unknown): string | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return (Math.round(n * 1e5) / 1e5).toFixed(5);
}

function routeKeyPoint(p: LatLngInput): string | null {
  if (!p || typeof p !== "object") return null;
  const lat = routeKeyCoord(p.lat);
  const lng = routeKeyCoord(p.lng);
  if (lat == null || lng == null) return null;
  return `${lat},${lng}`;
}

/**
 * Canonical route identity: ordered pickup → stops → dropoff at ~1 m.
 * Same key from calculate-route, calculate-fare and the booking quote.
 * Any invalid point → null (no artifact can be bound).
 */
export function buildServerRouteKey(input: {
  pickup: LatLngInput;
  dropoff: LatLngInput;
  stops?: ReadonlyArray<LatLngInput> | null;
}): string | null {
  const p = routeKeyPoint(input.pickup);
  const d = routeKeyPoint(input.dropoff);
  if (!p || !d) return null;
  const stops: string[] = [];
  for (const s of input.stops ?? []) {
    const k = routeKeyPoint(s);
    if (!k) return null;
    stops.push(k);
  }
  return `p:${p}|s:${stops.join(";")}|d:${d}`;
}

function finiteNumber(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function expiresInFuture(expiresAt: unknown, nowMs: number): boolean {
  const ms = Date.parse(String(expiresAt ?? ""));
  return Number.isFinite(ms) && ms > nowMs;
}

// ─── Service area (server geofence) ──────────────────────────

/** Same polygon semantics as resolve-service-area (point_in_polygon on active SAs). */
export async function resolveServiceAreaIdForPickup(
  admin: SupabaseClient,
  pickup: LatLngInput,
): Promise<{ ok: true; serviceAreaId: string | null } | { ok: false; error: string }> {
  const lat = finiteNumber(pickup?.lat);
  const lng = finiteNumber(pickup?.lng);
  if (lat == null || lng == null) return { ok: true, serviceAreaId: null };
  const { data, error } = await admin.rpc("find_service_area_by_location", {
    p_lat: lat,
    p_lng: lng,
  });
  if (error) return { ok: false, error: error.message ?? "service_area_lookup_failed" };
  return { ok: true, serviceAreaId: isUuid(data) ? String(data) : null };
}

// ─── Route artifact ───────────────────────────────────────────

export type RouteArtifactRow = {
  id: string;
  user_id: string;
  route_key: string;
  distance_meters: number;
  duration_seconds: number;
  distance_km: number;
  duration_min: number;
  provider: string;
  service_area_id: string | null;
  created_at: string;
  expires_at: string;
  schema_version: number;
};

export const ROUTE_ARTIFACT_SELECT =
  "id, user_id, route_key, distance_meters, duration_seconds, distance_km, duration_min, provider, service_area_id, created_at, expires_at, schema_version";

export function buildRouteArtifactInsert(input: {
  userId: string;
  pickup: LatLngInput;
  dropoff: LatLngInput;
  stops?: ReadonlyArray<LatLngInput> | null;
  distanceMeters: number;
  durationSeconds: number;
  provider: string;
  profile: string | null;
  departureAt: string | null;
  serviceAreaId: string | null;
  nowMs: number;
}): Record<string, unknown> | null {
  if (!isUuid(input.userId)) return null;
  if (input.provider !== ROUTE_ARTIFACT_PROVIDER) return null;
  const routeKey = buildServerRouteKey(input);
  if (!routeKey) return null;
  const meters = Math.round(Number(input.distanceMeters));
  const seconds = Math.round(Number(input.durationSeconds));
  if (!Number.isFinite(meters) || meters <= 0) return null;
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  const stops = (input.stops ?? []).map((s) => ({ lat: Number(s?.lat), lng: Number(s?.lng) }));
  return {
    user_id: input.userId,
    route_key: routeKey,
    pickup_lat: Number(input.pickup?.lat),
    pickup_lng: Number(input.pickup?.lng),
    dropoff_lat: Number(input.dropoff?.lat),
    dropoff_lng: Number(input.dropoff?.lng),
    stops,
    distance_meters: meters,
    duration_seconds: seconds,
    distance_km: Math.round((meters / 1000) * 100) / 100,
    duration_min: Math.ceil(seconds / 60),
    provider: input.provider,
    profile: input.profile,
    departure_at: input.departureAt,
    service_area_id: isUuid(input.serviceAreaId) ? input.serviceAreaId : null,
    schema_version: SERVER_FARE_ARTIFACT_SCHEMA_VERSION,
    created_at: new Date(input.nowMs).toISOString(),
    expires_at: new Date(input.nowMs + ROUTE_ARTIFACT_TTL_MS).toISOString(),
  };
}

export async function persistRouteArtifact(
  admin: SupabaseClient,
  insert: Record<string, unknown>,
): Promise<{ id: string; expires_at: string } | null> {
  const { data, error } = await admin
    .from("route_quote_artifacts")
    .insert(insert)
    .select("id, expires_at")
    .single();
  if (error || !data) {
    console.error("[serverFareAuthority] route artifact insert failed", error?.message);
    return null;
  }
  const row = data as { id: string; expires_at: string };
  return { id: String(row.id), expires_at: String(row.expires_at) };
}

function routeArtifactFromDb(raw: Record<string, unknown>): RouteArtifactRow {
  return {
    id: String(raw.id),
    user_id: String(raw.user_id),
    route_key: String(raw.route_key ?? ""),
    distance_meters: Number(raw.distance_meters),
    duration_seconds: Number(raw.duration_seconds),
    distance_km: Number(raw.distance_km),
    duration_min: Number(raw.duration_min),
    provider: String(raw.provider ?? ""),
    service_area_id: raw.service_area_id != null ? String(raw.service_area_id) : null,
    created_at: String(raw.created_at ?? ""),
    expires_at: String(raw.expires_at ?? ""),
    schema_version: Number(raw.schema_version ?? 0),
  };
}

export type RouteArtifactCheck =
  | { ok: true; artifact: RouteArtifactRow }
  | { ok: false; reason: "not_found" | "owner_mismatch" | "expired" | "route_mismatch" | "invalid" };

/** Pure: an artifact may price a request only for its owner, route, and lifetime. */
export function validateRouteArtifactForFare(
  artifact: RouteArtifactRow | null,
  ctx: { userId: string; routeKey: string; nowMs: number },
): RouteArtifactCheck {
  if (!artifact) return { ok: false, reason: "not_found" };
  if (artifact.user_id !== ctx.userId) return { ok: false, reason: "owner_mismatch" };
  if (artifact.route_key !== ctx.routeKey) return { ok: false, reason: "route_mismatch" };
  if (!expiresInFuture(artifact.expires_at, ctx.nowMs)) return { ok: false, reason: "expired" };
  if (
    artifact.provider !== ROUTE_ARTIFACT_PROVIDER
    || !(artifact.distance_km > 0)
    || !(artifact.duration_min >= 0)
    || artifact.schema_version !== SERVER_FARE_ARTIFACT_SCHEMA_VERSION
  ) {
    return { ok: false, reason: "invalid" };
  }
  return { ok: true, artifact };
}

/**
 * Explicit id → that artifact only (no fallback). No id → newest unexpired
 * artifact for (user, route). Installed Customer builds take the lookup path.
 */
export async function loadRouteArtifactForFare(
  admin: SupabaseClient,
  ctx: { userId: string; routeKey: string; routeQuoteId?: string | null; nowMs: number },
): Promise<RouteArtifactCheck | { ok: false; reason: "lookup_failed" }> {
  if (ctx.routeQuoteId != null && ctx.routeQuoteId !== "") {
    if (!isUuid(ctx.routeQuoteId)) return { ok: false, reason: "not_found" };
    const { data, error } = await admin
      .from("route_quote_artifacts")
      .select(ROUTE_ARTIFACT_SELECT)
      .eq("id", ctx.routeQuoteId)
      .eq("user_id", ctx.userId)
      .maybeSingle();
    if (error) return { ok: false, reason: "lookup_failed" };
    return validateRouteArtifactForFare(
      data ? routeArtifactFromDb(data as Record<string, unknown>) : null,
      ctx,
    );
  }
  const { data, error } = await admin
    .from("route_quote_artifacts")
    .select(ROUTE_ARTIFACT_SELECT)
    .eq("user_id", ctx.userId)
    .eq("route_key", ctx.routeKey)
    .gt("expires_at", new Date(ctx.nowMs).toISOString())
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return { ok: false, reason: "lookup_failed" };
  return validateRouteArtifactForFare(
    data ? routeArtifactFromDb(data as Record<string, unknown>) : null,
    ctx,
  );
}

// ─── Fare artifact ────────────────────────────────────────────

export type ServerFareArtifactRow = {
  id: string;
  user_id: string;
  route_quote_id: string;
  route_key: string;
  service_area_id: string;
  vehicle_type_id: string;
  currency: string;
  distance_km: number;
  duration_min: number;
  gross_fare_pence: number;
  airport_charge_pence: number;
  surge_multiplier: number;
  surge_quote_id: string | null;
  fare_source: string | null;
  pricing_mode: string | null;
  minimum_applied: boolean;
  engine: string;
  pricing_hash: string;
  schema_version: number;
  created_at: string;
  expires_at: string;
};

export const SERVER_FARE_ARTIFACT_SELECT =
  "id, user_id, route_quote_id, route_key, service_area_id, vehicle_type_id, currency, distance_km, duration_min, gross_fare_pence, airport_charge_pence, surge_multiplier, surge_quote_id, fare_source, pricing_mode, minimum_applied, engine, pricing_hash, schema_version, created_at, expires_at";

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${
    Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
      .join(",")
  }}`;
}

export async function computePricingHash(evidence: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(stableStringify(evidence));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type FareArtifactPricingInput = {
  vehicleTypeId: string;
  grossFarePence: number;
  airportChargePence: number;
  surgeMultiplier: number;
  surgeQuoteId: string | null;
  fareSource: string | null;
  pricingMode: string | null;
  minimumApplied: boolean;
  evidence: Record<string, unknown>;
};

export async function buildFareArtifactInserts(input: {
  route: RouteArtifactRow;
  serviceAreaId: string;
  currency: string;
  isScheduled: boolean;
  fares: FareArtifactPricingInput[];
  nowMs: number;
}): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  for (const f of input.fares) {
    const gross = Math.round(Number(f.grossFarePence));
    if (!isUuid(f.vehicleTypeId) || !Number.isFinite(gross) || gross <= 0) continue;
    const evidence = {
      engine: SERVER_FARE_ENGINE,
      route_quote_id: input.route.id,
      route_key: input.route.route_key,
      distance_km: input.route.distance_km,
      duration_min: input.route.duration_min,
      service_area_id: input.serviceAreaId,
      vehicle_type_id: f.vehicleTypeId,
      currency: input.currency,
      gross_fare_pence: gross,
      ...f.evidence,
    };
    rows.push({
      user_id: input.route.user_id,
      route_quote_id: input.route.id,
      route_key: input.route.route_key,
      service_area_id: input.serviceAreaId,
      vehicle_type_id: f.vehicleTypeId,
      currency: String(input.currency).trim().toLowerCase(),
      distance_km: input.route.distance_km,
      duration_min: input.route.duration_min,
      gross_fare_pence: gross,
      airport_charge_pence: Math.max(0, Math.round(Number(f.airportChargePence) || 0)),
      surge_multiplier: Math.max(1, Number(f.surgeMultiplier) || 1),
      surge_quote_id: f.surgeQuoteId,
      fare_source: f.fareSource,
      pricing_mode: f.pricingMode,
      minimum_applied: f.minimumApplied === true,
      is_scheduled: input.isScheduled,
      engine: SERVER_FARE_ENGINE,
      pricing_evidence: evidence,
      pricing_hash: await computePricingHash(evidence),
      schema_version: SERVER_FARE_ARTIFACT_SCHEMA_VERSION,
      created_at: new Date(input.nowMs).toISOString(),
      expires_at: new Date(input.nowMs + FARE_ARTIFACT_TTL_MS).toISOString(),
    });
  }
  return rows;
}

/** One batched insert per calculate-fare. Returns vehicle_type_id → artifact id. */
export async function persistFareArtifacts(
  admin: SupabaseClient,
  rows: Record<string, unknown>[],
): Promise<Map<string, { id: string; expires_at: string }> | null> {
  if (rows.length === 0) return new Map();
  const { data, error } = await admin
    .from("server_fare_quotes")
    .insert(rows)
    .select("id, vehicle_type_id, expires_at");
  if (error || !Array.isArray(data)) {
    console.error("[serverFareAuthority] fare artifact insert failed", error?.message);
    return null;
  }
  const out = new Map<string, { id: string; expires_at: string }>();
  for (const r of data as Array<{ id: string; vehicle_type_id: string; expires_at: string }>) {
    out.set(String(r.vehicle_type_id), { id: String(r.id), expires_at: String(r.expires_at) });
  }
  return out;
}

function fareArtifactFromDb(raw: Record<string, unknown>): ServerFareArtifactRow {
  return {
    id: String(raw.id),
    user_id: String(raw.user_id),
    route_quote_id: String(raw.route_quote_id),
    route_key: String(raw.route_key ?? ""),
    service_area_id: String(raw.service_area_id ?? ""),
    vehicle_type_id: String(raw.vehicle_type_id ?? ""),
    currency: String(raw.currency ?? "").toLowerCase(),
    distance_km: Number(raw.distance_km),
    duration_min: Number(raw.duration_min),
    gross_fare_pence: Math.round(Number(raw.gross_fare_pence)),
    airport_charge_pence: Math.round(Number(raw.airport_charge_pence ?? 0)),
    surge_multiplier: Number(raw.surge_multiplier ?? 1),
    surge_quote_id: raw.surge_quote_id != null ? String(raw.surge_quote_id) : null,
    fare_source: raw.fare_source != null ? String(raw.fare_source) : null,
    pricing_mode: raw.pricing_mode != null ? String(raw.pricing_mode) : null,
    minimum_applied: raw.minimum_applied === true,
    engine: String(raw.engine ?? ""),
    pricing_hash: String(raw.pricing_hash ?? ""),
    schema_version: Number(raw.schema_version ?? 0),
    created_at: String(raw.created_at ?? ""),
    expires_at: String(raw.expires_at ?? ""),
  };
}

export type ServerFareArtifactCode =
  | typeof FARE_QUOTE_UNAVAILABLE
  | typeof SERVICE_AREA_MISMATCH
  | "FARE_QUOTE_EXPIRED"
  | "FARE_QUOTE_CHANGED";

export type ServerFareArtifactCheck =
  | { ok: true; artifact: ServerFareArtifactRow }
  | { ok: false; code: ServerFareArtifactCode; note: string };

/**
 * Pure binding check for the booking quote. Every field the payment depends
 * on must equal the request; the artifact's gross is the only fare input.
 */
export function validateServerFareArtifactForQuote(
  artifact: ServerFareArtifactRow | null,
  ctx: {
    userId: string;
    routeKey: string;
    vehicleTypeId: string;
    serviceAreaId: string;
    nowMs: number;
  },
): ServerFareArtifactCheck {
  if (!artifact) return { ok: false, code: FARE_QUOTE_UNAVAILABLE, note: "fare_artifact_not_found" };
  if (artifact.user_id !== ctx.userId) {
    return { ok: false, code: FARE_QUOTE_UNAVAILABLE, note: "fare_artifact_owner_mismatch" };
  }
  if (!expiresInFuture(artifact.expires_at, ctx.nowMs)) {
    return { ok: false, code: "FARE_QUOTE_EXPIRED", note: "fare_artifact_expired" };
  }
  if (artifact.route_key !== ctx.routeKey) {
    return { ok: false, code: "FARE_QUOTE_CHANGED", note: "fare_artifact_route_mismatch" };
  }
  if (artifact.vehicle_type_id !== ctx.vehicleTypeId) {
    return { ok: false, code: "FARE_QUOTE_CHANGED", note: "fare_artifact_vehicle_mismatch" };
  }
  if (artifact.service_area_id !== ctx.serviceAreaId) {
    return { ok: false, code: SERVICE_AREA_MISMATCH, note: "fare_artifact_service_area_mismatch" };
  }
  if (
    artifact.engine !== SERVER_FARE_ENGINE
    || artifact.schema_version !== SERVER_FARE_ARTIFACT_SCHEMA_VERSION
    || !(artifact.gross_fare_pence > 0)
    || !artifact.pricing_hash
  ) {
    return { ok: false, code: FARE_QUOTE_UNAVAILABLE, note: "fare_artifact_invalid" };
  }
  return { ok: true, artifact };
}

export async function loadServerFareArtifactForQuote(
  admin: SupabaseClient,
  ctx: {
    userId: string;
    routeKey: string;
    vehicleTypeId: string;
    serviceAreaId: string;
    serverFareQuoteId?: string | null;
    nowMs: number;
  },
): Promise<ServerFareArtifactCheck> {
  let data: unknown = null;
  if (ctx.serverFareQuoteId != null && ctx.serverFareQuoteId !== "") {
    if (!isUuid(ctx.serverFareQuoteId)) {
      return { ok: false, code: FARE_QUOTE_UNAVAILABLE, note: "fare_artifact_id_invalid" };
    }
    const res = await admin
      .from("server_fare_quotes")
      .select(SERVER_FARE_ARTIFACT_SELECT)
      .eq("id", ctx.serverFareQuoteId)
      .eq("user_id", ctx.userId)
      .maybeSingle();
    if (res.error) return { ok: false, code: FARE_QUOTE_UNAVAILABLE, note: "fare_artifact_lookup_failed" };
    data = res.data;
  } else {
    const res = await admin
      .from("server_fare_quotes")
      .select(SERVER_FARE_ARTIFACT_SELECT)
      .eq("user_id", ctx.userId)
      .eq("route_key", ctx.routeKey)
      .eq("vehicle_type_id", ctx.vehicleTypeId)
      .gt("expires_at", new Date(ctx.nowMs).toISOString())
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (res.error) return { ok: false, code: FARE_QUOTE_UNAVAILABLE, note: "fare_artifact_lookup_failed" };
    data = res.data;
  }
  return validateServerFareArtifactForQuote(
    data ? fareArtifactFromDb(data as Record<string, unknown>) : null,
    ctx,
  );
}

// ─── Payment-session fare snapshot ────────────────────────────

/**
 * Keys trip creation reads as money. A client fare_snapshot never reaches
 * payment_sessions.fare_snapshot with any of these.
 */
const FARE_MONEY_KEY_RE =
  /pence|amount|fare|discount|surge|airport|buffer|total|price|charge|fee|commission|toll|tip|subsidy|promo|voucher|offer|receivable/i;

export function stripFareSnapshotMoneyKeys(
  snapshot: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!snapshot || typeof snapshot !== "object") return out;
  for (const [k, v] of Object.entries(snapshot)) {
    if (FARE_MONEY_KEY_RE.test(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * create-preauth session snapshot. Money comes only from server-resolved
 * values; from the client snapshot only `booking_source` survives.
 */
export function buildServerPreauthSessionFareSnapshot(input: {
  estimatedTotalPence: number;
  authorisedAmountPence: number;
  bufferPence: number;
  metadataExtra: Record<string, string>;
  clientFareSnapshot?: Record<string, unknown> | null;
}): Record<string, unknown> {
  const out: Record<string, unknown> = {
    estimated_total_pence: input.estimatedTotalPence,
    authorised_amount_pence: input.authorisedAmountPence,
    buffer_pence: input.bufferPence,
    ...input.metadataExtra,
    fare_snapshot_authority: "server",
  };
  const source = input.clientFareSnapshot?.booking_source;
  if (typeof source === "string" && source.length > 0 && source.length <= 64) {
    out.booking_source = source;
  }
  return out;
}

/**
 * Opaque quote path: the consumed quote row is the money. Gross = final =
 * quote trip fare and discount 0 keep live trip-creation parity; the
 * gross/discount attribution defect is tracked separately and must not be
 * changed here (a discount would be stamped global_offer for vouchers).
 */
export function buildOpaqueQuoteSessionFareSnapshot(
  base: Record<string, unknown> | null | undefined,
  quote: {
    id: string;
    trip_fare_pence: number;
    buffer_pence: number;
    total_authorisation_pence: number;
    server_fare_quote_id?: string | null;
  },
): Record<string, unknown> {
  return {
    ...stripFareSnapshotMoneyKeys(base),
    estimated_total_pence: quote.trip_fare_pence,
    final_fare_pence: quote.trip_fare_pence,
    gross_fare_pence: quote.trip_fare_pence,
    offer_discount_pence: 0,
    buffer_pence: quote.buffer_pence,
    authorised_amount_pence: quote.total_authorisation_pence,
    booking_payment_quote_id: quote.id,
    server_fare_quote_id: quote.server_fare_quote_id ?? null,
    fare_snapshot_authority: "booking_payment_quote",
  };
}
