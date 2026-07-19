/**
 * Admin Region / Service Area boundary editor SSOT.
 * Canonical on-disk format for regions/service_areas.geo_boundary remains
 * `{ lat, lng }[]` (closed or open ring) for PIP compatibility.
 * Editor may work in GeoJSON Polygon / MultiPolygon and normalize on save.
 */

export type BoundarySetupMethod = "official" | "draw" | "import" | "radius" | "copy";

export type OfficialAdminLevel =
  | "country"
  | "state"
  | "county"
  | "city";

export const OFFICIAL_ADMIN_LEVEL_LABELS: Record<OfficialAdminLevel, string> = {
  country: "Country boundary",
  state: "State / Province / Region",
  county: "County / District",
  city: "City / Municipality",
};

export type LatLng = { lat: number; lng: number };

export type BoundaryGeometryKind = "Polygon" | "MultiPolygon";

export interface BoundaryValidationIssue {
  code:
    | "TOO_FEW_POINTS"
    | "SELF_INTERSECTION"
    | "ZERO_AREA"
    | "UNCLOSED_RING"
    | "DUPLICATE_POINTS"
    | "INVALID_COORDS"
    | "WORLD_SPANNING"
    | "OUTSIDE_PARENT"
    | "OVERLAP"
    | "NULL_GEOMETRY";
  severity: "error" | "warning";
  message: string;
  meta?: Record<string, unknown>;
}

export interface BoundarySummary {
  kind: BoundaryGeometryKind;
  pointCount: number;
  areaSqMeters: number;
  perimeterMeters: number;
  bbox: [number, number, number, number] | null; // west,south,east,north
}

export const BOUNDARY_MIN_POINTS = 3;
/** Soft cap before we recommend simplify for display. */
export const BOUNDARY_DISPLAY_SIMPLIFY_THRESHOLD = 800;

export function latLngRingToGeoJsonPolygon(points: LatLng[]): GeoJSON.Feature<GeoJSON.Polygon> | null {
  if (!points || points.length < BOUNDARY_MIN_POINTS) return null;
  const ring = points.map((p) => [p.lng, p.lat] as [number, number]);
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    ring.push([first[0], first[1]]);
  }
  return {
    type: "Feature",
    properties: {},
    geometry: { type: "Polygon", coordinates: [ring] },
  };
}

export function geoJsonPolygonToLatLngRing(
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon | null | undefined,
): LatLng[] | null {
  if (!geometry) return null;
  if (geometry.type === "Polygon") {
    const ring = geometry.coordinates?.[0];
    if (!ring || ring.length < BOUNDARY_MIN_POINTS) return null;
    const open = ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
      ? ring.slice(0, -1)
      : ring;
    return open.map((c) => ({ lng: Number(c[0]), lat: Number(c[1]) }));
  }
  if (geometry.type === "MultiPolygon") {
    // Canonical LatLng[] storage is single-ring; use largest polygon as primary.
    let best: number[][] | null = null;
    let bestLen = 0;
    for (const poly of geometry.coordinates ?? []) {
      const ring = poly?.[0];
      if (ring && ring.length > bestLen) {
        best = ring;
        bestLen = ring.length;
      }
    }
    if (!best) return null;
    return geoJsonPolygonToLatLngRing({ type: "Polygon", coordinates: [best] });
  }
  return null;
}

export function normalizeLatLngRing(points: LatLng[]): LatLng[] {
  const cleaned: LatLng[] = [];
  for (const p of points) {
    const lat = Number(p.lat);
    const lng = Number(p.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
    const prev = cleaned[cleaned.length - 1];
    if (prev && prev.lat === lat && prev.lng === lng) continue;
    cleaned.push({ lat, lng });
  }
  if (cleaned.length >= 2) {
    const a = cleaned[0];
    const b = cleaned[cleaned.length - 1];
    if (a.lat === b.lat && a.lng === b.lng) cleaned.pop();
  }
  return cleaned;
}

export function parseImportedGeoJson(raw: unknown): {
  ok: true;
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon;
} | {
  ok: false;
  message: string;
} {
  try {
    const obj = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!obj || typeof obj !== "object") {
      return { ok: false, message: "Import is not valid JSON." };
    }
    const g = obj as Record<string, unknown>;
    if (g.type === "Feature" && g.geometry && typeof g.geometry === "object") {
      return parseImportedGeoJson(g.geometry);
    }
    if (g.type === "FeatureCollection" && Array.isArray(g.features)) {
      const polys = (g.features as unknown[])
        .map((f) => (f as { geometry?: unknown })?.geometry)
        .filter(Boolean);
      for (const geom of polys) {
        const parsed = parseImportedGeoJson(geom);
        if (parsed.ok) return parsed;
      }
      return { ok: false, message: "FeatureCollection has no Polygon/MultiPolygon." };
    }
    if (g.type === "Polygon" && Array.isArray(g.coordinates)) {
      return { ok: true, geometry: g as unknown as GeoJSON.Polygon };
    }
    if (g.type === "MultiPolygon" && Array.isArray(g.coordinates)) {
      return { ok: true, geometry: g as unknown as GeoJSON.MultiPolygon };
    }
    return { ok: false, message: "Expected Polygon, MultiPolygon, Feature, or FeatureCollection." };
  } catch {
    return { ok: false, message: "Could not parse GeoJSON." };
  }
}

/** Minimal KML Polygon extractor (coordinates text → GeoJSON Polygon). */
export function parseSimpleKmlPolygon(kmlText: string): {
  ok: true;
  geometry: GeoJSON.Polygon;
} | {
  ok: false;
  message: string;
} {
  const match = kmlText.match(/<coordinates[^>]*>([\s\S]*?)<\/coordinates>/i);
  if (!match) return { ok: false, message: "No <coordinates> found in KML." };
  const ring: [number, number][] = [];
  for (const token of match[1].trim().split(/\s+/)) {
    const parts = token.split(",");
    if (parts.length < 2) continue;
    const lng = Number(parts[0]);
    const lat = Number(parts[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    ring.push([lng, lat]);
  }
  if (ring.length < BOUNDARY_MIN_POINTS) {
    return { ok: false, message: "KML polygon needs at least 3 points." };
  }
  if (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1]) {
    ring.push([ring[0][0], ring[0][1]]);
  }
  return { ok: true, geometry: { type: "Polygon", coordinates: [ring] } };
}

export function defaultBoundaryMethodForEntity(
  entity: "region" | "service_area",
): BoundarySetupMethod {
  return entity === "region" ? "official" : "draw";
}

export function formatAreaSqMeters(areaSqMeters: number, unit: "km" | "mile" = "km"): string {
  if (!Number.isFinite(areaSqMeters) || areaSqMeters <= 0) return "—";
  if (unit === "mile") {
    const sqMi = areaSqMeters / 2_589_988.110336;
    return sqMi >= 10 ? `${sqMi.toFixed(0)} sq mi` : `${sqMi.toFixed(2)} sq mi`;
  }
  const sqKm = areaSqMeters / 1_000_000;
  return sqKm >= 10 ? `${sqKm.toFixed(0)} km²` : `${sqKm.toFixed(2)} km²`;
}

export function bboxFromLatLng(points: LatLng[]): [number, number, number, number] | null {
  if (!points.length) return null;
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const p of points) {
    west = Math.min(west, p.lng);
    east = Math.max(east, p.lng);
    south = Math.min(south, p.lat);
    north = Math.max(north, p.lat);
  }
  if (!Number.isFinite(west)) return null;
  return [west, south, east, north];
}

export function isWorldSpanningBbox(bbox: [number, number, number, number] | null): boolean {
  if (!bbox) return false;
  const [west, south, east, north] = bbox;
  return east - west > 80 || north - south > 60;
}

/**
 * Structural validation that does not require turf (safe in unit tests / Deno).
 * Self-intersection / area / containment use turf helpers in the client adapter.
 */
export function validateLatLngRingStructure(points: LatLng[] | null | undefined): BoundaryValidationIssue[] {
  const issues: BoundaryValidationIssue[] = [];
  if (!points || points.length === 0) {
    issues.push({
      code: "NULL_GEOMETRY",
      severity: "error",
      message: "No boundary geometry provided.",
    });
    return issues;
  }
  const normalized = normalizeLatLngRing(points);
  if (normalized.length < BOUNDARY_MIN_POINTS) {
    issues.push({
      code: "TOO_FEW_POINTS",
      severity: "error",
      message: `Boundary needs at least ${BOUNDARY_MIN_POINTS} points (has ${normalized.length}).`,
    });
  }
  for (const p of points) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng) || Math.abs(p.lat) > 90 || Math.abs(p.lng) > 180) {
      issues.push({
        code: "INVALID_COORDS",
        severity: "error",
        message: "Boundary contains invalid latitude/longitude values.",
      });
      break;
    }
  }
  const bbox = bboxFromLatLng(normalized);
  if (isWorldSpanningBbox(bbox)) {
    issues.push({
      code: "WORLD_SPANNING",
      severity: "error",
      message: "Boundary spans an implausibly large area — check coordinates.",
    });
  }
  return issues;
}

export function buildBoundaryPreviewSummary(input: {
  name: string;
  parentRegionName?: string | null;
  method: BoundarySetupMethod;
  pointCount: number;
  areaLabel: string;
  insideParent: boolean | null;
  overlapLabel: string | null;
  validationPassed: boolean;
}): string[] {
  return [
    `Name: ${input.name || "—"}`,
    `Parent Region: ${input.parentRegionName || "—"}`,
    `Method: ${input.method}`,
    `Points: ${input.pointCount}`,
    `Approximate area: ${input.areaLabel}`,
    `Inside parent Region: ${input.insideParent == null ? "—" : input.insideParent ? "Yes" : "No"}`,
    `Overlaps active Service Areas: ${input.overlapLabel ?? "—"}`,
    `Validation: ${input.validationPassed ? "Passed" : "Failed"}`,
  ];
}
