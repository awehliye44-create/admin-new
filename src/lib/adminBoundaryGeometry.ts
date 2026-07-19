/**
 * Turf-backed boundary geometry helpers for Admin editor (browser only).
 */
import * as turf from "@turf/turf";
import {
  type BoundarySummary,
  type BoundaryValidationIssue,
  type LatLng,
  BOUNDARY_MIN_POINTS,
  bboxFromLatLng,
  geoJsonPolygonToLatLngRing,
  latLngRingToGeoJsonPolygon,
  normalizeLatLngRing,
  validateLatLngRingStructure,
} from "../../shared/adminBoundaryEditorSSOT";

export function summarizeBoundary(points: LatLng[]): BoundarySummary {
  const normalized = normalizeLatLngRing(points);
  const feature = latLngRingToGeoJsonPolygon(normalized);
  let areaSqMeters = 0;
  let perimeterMeters = 0;
  if (feature) {
    try {
      areaSqMeters = Math.abs(turf.area(feature));
      perimeterMeters = turf.length(feature, { units: "kilometers" }) * 1000;
    } catch {
      areaSqMeters = 0;
      perimeterMeters = 0;
    }
  }
  return {
    kind: "Polygon",
    pointCount: normalized.length,
    areaSqMeters,
    perimeterMeters,
    bbox: bboxFromLatLng(normalized),
  };
}

export function validateBoundaryGeometry(points: LatLng[] | null | undefined): BoundaryValidationIssue[] {
  const issues = validateLatLngRingStructure(points);
  if (!points || points.length < BOUNDARY_MIN_POINTS) return issues;
  const feature = latLngRingToGeoJsonPolygon(normalizeLatLngRing(points));
  if (!feature) return issues;
  try {
    const area = Math.abs(turf.area(feature));
    if (area < 1) {
      issues.push({
        code: "ZERO_AREA",
        severity: "error",
        message: "Boundary has near-zero area.",
      });
    }
    const kinks = turf.kinks(feature);
    if (kinks.features.length > 0) {
      issues.push({
        code: "SELF_INTERSECTION",
        severity: "error",
        message: "Boundary self-intersects — fix crossing edges before saving.",
      });
    }
  } catch {
    // ignore turf failures; structural checks already ran
  }
  return issues;
}

export function isBoundaryInsideParent(
  child: LatLng[],
  parent: LatLng[] | null | undefined,
): { inside: boolean; outsidePointCount: number } {
  if (!parent || parent.length < BOUNDARY_MIN_POINTS) {
    return { inside: true, outsidePointCount: 0 };
  }
  const parentFeature = latLngRingToGeoJsonPolygon(normalizeLatLngRing(parent));
  if (!parentFeature) return { inside: true, outsidePointCount: 0 };
  let outside = 0;
  for (const p of normalizeLatLngRing(child)) {
    const pt = turf.point([p.lng, p.lat]);
    if (!turf.booleanPointInPolygon(pt, parentFeature)) outside += 1;
  }
  return { inside: outside === 0, outsidePointCount: outside };
}

export function clipBoundaryToParent(child: LatLng[], parent: LatLng[]): LatLng[] | null {
  const childF = latLngRingToGeoJsonPolygon(normalizeLatLngRing(child));
  const parentF = latLngRingToGeoJsonPolygon(normalizeLatLngRing(parent));
  if (!childF || !parentF) return null;
  try {
    const clipped = turf.intersect(
      turf.featureCollection([childF, parentF]),
    );
    if (!clipped) return null;
    const geom = clipped.geometry;
    if (geom.type === "Polygon" || geom.type === "MultiPolygon") {
      return geoJsonPolygonToLatLngRing(geom);
    }
  } catch {
    return null;
  }
  return null;
}

/** Subtract sibling polygon from candidate (clip overlap). Returns primary ring. */
export function clipOverlapFromSibling(candidate: LatLng[], sibling: LatLng[]): LatLng[] | null {
  const a = latLngRingToGeoJsonPolygon(normalizeLatLngRing(candidate));
  const b = latLngRingToGeoJsonPolygon(normalizeLatLngRing(sibling));
  if (!a || !b) return null;
  try {
    const diff = turf.difference(turf.featureCollection([a, b]));
    if (!diff) return null;
    const geom = diff.geometry;
    if (geom.type === "Polygon" || geom.type === "MultiPolygon") {
      return geoJsonPolygonToLatLngRing(geom);
    }
  } catch {
    return null;
  }
  return null;
}

export function measureOverlapPercent(
  a: LatLng[],
  b: LatLng[],
): number {
  const af = latLngRingToGeoJsonPolygon(normalizeLatLngRing(a));
  const bf = latLngRingToGeoJsonPolygon(normalizeLatLngRing(b));
  if (!af || !bf) return 0;
  try {
    const inter = turf.intersect(turf.featureCollection([af, bf]));
    if (!inter) return 0;
    const areaA = Math.abs(turf.area(af));
    if (areaA <= 0) return 0;
    return (Math.abs(turf.area(inter)) / areaA) * 100;
  } catch {
    return 0;
  }
}

export function findServiceAreaOverlaps(
  candidate: LatLng[],
  siblings: Array<{ id: string; name: string; geo_boundary: LatLng[] | null }>,
  excludeId?: string | null,
): Array<{ id: string; name: string; overlapPercent: number }> {
  const out: Array<{ id: string; name: string; overlapPercent: number }> = [];
  for (const s of siblings) {
    if (excludeId && s.id === excludeId) continue;
    if (!s.geo_boundary || s.geo_boundary.length < BOUNDARY_MIN_POINTS) continue;
    const pct = measureOverlapPercent(candidate, s.geo_boundary);
    if (pct >= 1) out.push({ id: s.id, name: s.name, overlapPercent: Math.round(pct * 10) / 10 });
  }
  return out.sort((x, y) => y.overlapPercent - x.overlapPercent);
}

export function generateRadiusPolygon(center: LatLng, radiusKm: number, steps = 64): LatLng[] {
  const circle = turf.circle([center.lng, center.lat], radiusKm, {
    steps,
    units: "kilometers",
  });
  return geoJsonPolygonToLatLngRing(circle.geometry) ?? [];
}

export function simplifyBoundaryForDisplay(points: LatLng[], tolerance = 0.001): LatLng[] {
  const feature = latLngRingToGeoJsonPolygon(normalizeLatLngRing(points));
  if (!feature) return points;
  try {
    const simplified = turf.simplify(feature, { tolerance, highQuality: true });
    return geoJsonPolygonToLatLngRing(simplified.geometry as GeoJSON.Polygon) ?? points;
  } catch {
    return points;
  }
}

export function fitBoundsPadding(): number {
  return 48;
}

export function formatPerimeterMeters(meters: number): string {
  if (!Number.isFinite(meters) || meters <= 0) return "—";
  if (meters >= 1000) return `${(meters / 1000).toFixed(1)} km`;
  return `${Math.round(meters)} m`;
}

/** Snap a click to the nearest point on a polyline/ring (parent or official boundary). */
export function snapLatLngToBoundary(
  point: LatLng,
  boundary: LatLng[] | null | undefined,
  maxSnapMeters = 2500,
): LatLng {
  if (!boundary || boundary.length < 2) return point;
  try {
    const line = turf.lineString(boundary.map((p) => [p.lng, p.lat]));
    const snapped = turf.nearestPointOnLine(line, turf.point([point.lng, point.lat]), {
      units: "meters",
    });
    const dist = snapped.properties?.dist ?? Infinity;
    if (dist > maxSnapMeters) return point;
    const [lng, lat] = snapped.geometry.coordinates;
    return { lat, lng };
  } catch {
    return point;
  }
}

export function rectangleFromCorners(a: LatLng, b: LatLng): LatLng[] {
  const west = Math.min(a.lng, b.lng);
  const east = Math.max(a.lng, b.lng);
  const south = Math.min(a.lat, b.lat);
  const north = Math.max(a.lat, b.lat);
  return [
    { lat: south, lng: west },
    { lat: south, lng: east },
    { lat: north, lng: east },
    { lat: north, lng: west },
  ];
}

export function buildVertexFeatures(
  points: LatLng[],
  parent: LatLng[] | null | undefined,
): GeoJSON.FeatureCollection {
  const parentF =
    parent && parent.length >= BOUNDARY_MIN_POINTS
      ? latLngRingToGeoJsonPolygon(normalizeLatLngRing(parent))
      : null;
  return {
    type: "FeatureCollection",
    features: points.map((p, i) => {
      let outside = false;
      if (parentF) {
        outside = !turf.booleanPointInPolygon(turf.point([p.lng, p.lat]), parentF);
      }
      return {
        type: "Feature",
        properties: { index: i + 1, outside },
        geometry: { type: "Point", coordinates: [p.lng, p.lat] },
      };
    }),
  };
}

/** Convert MultiPolygon / Polygon GeoJSON into zone rings for the editor. */
export function geoJsonToZoneRings(
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon,
): LatLng[][] {
  if (geometry.type === "Polygon") {
    const ring = geoJsonPolygonToLatLngRing(geometry);
    return ring ? [ring] : [];
  }
  const zones: LatLng[][] = [];
  for (const poly of geometry.coordinates ?? []) {
    const ring = geoJsonPolygonToLatLngRing({ type: "Polygon", coordinates: poly });
    if (ring && ring.length >= BOUNDARY_MIN_POINTS) zones.push(ring);
  }
  return zones;
}

export function zoneRingsToGeoJson(
  zones: LatLng[][],
): GeoJSON.Polygon | GeoJSON.MultiPolygon | null {
  const polys: number[][][][] = [];
  for (const zone of zones) {
    const n = normalizeLatLngRing(zone);
    if (n.length < BOUNDARY_MIN_POINTS) continue;
    const ring = n.map((p) => [p.lng, p.lat] as [number, number]);
    ring.push([ring[0][0], ring[0][1]]);
    polys.push([ring]);
  }
  if (polys.length === 0) return null;
  if (polys.length === 1) return { type: "Polygon", coordinates: polys[0] };
  return { type: "MultiPolygon", coordinates: polys };
}

/** Canonical DB payload: LatLng[] for single ring, GeoJSON MultiPolygon for multi-zone. */
export function zonesToCanonicalGeoBoundary(zones: LatLng[][]): LatLng[] | GeoJSON.MultiPolygon | null {
  const valid = zones
    .map((z) => normalizeLatLngRing(z))
    .filter((z) => z.length >= BOUNDARY_MIN_POINTS);
  if (valid.length === 0) return null;
  if (valid.length === 1) return valid[0];
  const mp = zoneRingsToGeoJson(valid);
  return mp?.type === "MultiPolygon" ? mp : valid[0];
}
