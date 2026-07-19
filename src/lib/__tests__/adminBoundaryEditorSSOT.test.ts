import { describe, expect, it } from "vitest";
import {
  buildBoundaryPreviewSummary,
  defaultBoundaryMethodForEntity,
  geoJsonPolygonToLatLngRing,
  latLngRingToGeoJsonPolygon,
  normalizeLatLngRing,
  parseImportedGeoJson,
  parseSimpleKmlPolygon,
  validateLatLngRingStructure,
} from "../../../shared/adminBoundaryEditorSSOT";
import {
  rectangleFromCorners,
  snapLatLngToBoundary,
  zoneRingsToGeoJson,
  zonesToCanonicalGeoBoundary,
  clipOverlapFromSibling,
} from "../adminBoundaryGeometry";

describe("adminBoundaryEditorSSOT", () => {
  it("defaults Region to official and Service Area to draw", () => {
    expect(defaultBoundaryMethodForEntity("region")).toBe("official");
    expect(defaultBoundaryMethodForEntity("service_area")).toBe("draw");
  });

  it("rejects too few points", () => {
    const issues = validateLatLngRingStructure([
      { lat: 2, lng: 45 },
      { lat: 2.1, lng: 45.1 },
    ]);
    expect(issues.some((i) => i.code === "TOO_FEW_POINTS")).toBe(true);
  });

  it("round-trips LatLng ring ↔ GeoJSON Polygon", () => {
    const ring = [
      { lat: 2.0, lng: 45.0 },
      { lat: 2.1, lng: 45.0 },
      { lat: 2.1, lng: 45.2 },
      { lat: 2.0, lng: 45.2 },
    ];
    const feature = latLngRingToGeoJsonPolygon(ring);
    expect(feature?.geometry.type).toBe("Polygon");
    const back = geoJsonPolygonToLatLngRing(feature!.geometry);
    expect(normalizeLatLngRing(back!)).toEqual(normalizeLatLngRing(ring));
  });

  it("parses imported GeoJSON Polygon", () => {
    const parsed = parseImportedGeoJson({
      type: "Polygon",
      coordinates: [
        [
          [45, 2],
          [45.2, 2],
          [45.2, 2.2],
          [45, 2.2],
          [45, 2],
        ],
      ],
    });
    expect(parsed.ok).toBe(true);
  });

  it("parses simple KML coordinates", () => {
    const kml = `<?xml version="1.0"?><kml><Placemark><Polygon><outerBoundaryIs><LinearRing><coordinates>
45.0,2.0,0 45.2,2.0,0 45.2,2.2,0 45.0,2.2,0 45.0,2.0,0
</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></kml>`;
    const parsed = parseSimpleKmlPolygon(kml);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.geometry.coordinates[0].length).toBeGreaterThanOrEqual(4);
  });

  it("builds preview summary lines", () => {
    const lines = buildBoundaryPreviewSummary({
      name: "Banadir",
      parentRegionName: "Somalia",
      method: "official",
      pointCount: 111,
      areaLabel: "370 km²",
      insideParent: true,
      overlapLabel: "No",
      validationPassed: true,
    });
    expect(lines.join("\n")).toContain("Banadir");
    expect(lines.join("\n")).toContain("Validation: Passed");
  });

  it("rejects world-spanning bbox", () => {
    const issues = validateLatLngRingStructure([
      { lat: -80, lng: -170 },
      { lat: -80, lng: 170 },
      { lat: 80, lng: 170 },
      { lat: 80, lng: -170 },
    ]);
    expect(issues.some((i) => i.code === "WORLD_SPANNING")).toBe(true);
  });

  it("builds a rectangle from two corners", () => {
    const rect = rectangleFromCorners({ lat: 2, lng: 45 }, { lat: 3, lng: 46 });
    expect(rect).toHaveLength(4);
    expect(rect[0]).toEqual({ lat: 2, lng: 45 });
    expect(rect[2]).toEqual({ lat: 3, lng: 46 });
  });

  it("snaps a nearby point onto a boundary segment", () => {
    const boundary = [
      { lat: 2, lng: 45 },
      { lat: 2, lng: 46 },
      { lat: 3, lng: 46 },
    ];
    const snapped = snapLatLngToBoundary({ lat: 2.01, lng: 45.5 }, boundary, 5000);
    expect(Math.abs(snapped.lat - 2)).toBeLessThan(0.02);
    expect(snapped.lng).toBeCloseTo(45.5, 1);
  });

  it("stores MultiPolygon when multiple zones are present", () => {
    const a = [
      { lat: 2, lng: 45 },
      { lat: 2.1, lng: 45 },
      { lat: 2.1, lng: 45.1 },
      { lat: 2, lng: 45.1 },
    ];
    const b = [
      { lat: 3, lng: 46 },
      { lat: 3.1, lng: 46 },
      { lat: 3.1, lng: 46.1 },
      { lat: 3, lng: 46.1 },
    ];
    const canonical = zonesToCanonicalGeoBoundary([a, b]);
    expect(canonical && !Array.isArray(canonical) && canonical.type).toBe("MultiPolygon");
    const gj = zoneRingsToGeoJson([a, b]);
    expect(gj?.type).toBe("MultiPolygon");
  });

  it("clips overlap by subtracting sibling polygon", () => {
    const candidate = [
      { lat: 2, lng: 45 },
      { lat: 2.2, lng: 45 },
      { lat: 2.2, lng: 45.2 },
      { lat: 2, lng: 45.2 },
    ];
    const sibling = [
      { lat: 2.1, lng: 45.1 },
      { lat: 2.3, lng: 45.1 },
      { lat: 2.3, lng: 45.3 },
      { lat: 2.1, lng: 45.3 },
    ];
    const clipped = clipOverlapFromSibling(candidate, sibling);
    expect(clipped && clipped.length >= 3).toBe(true);
  });
});
