import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertTriangle,
  CheckCircle2,
  Expand,
  Loader2,
  MapPin,
  Search,
  Upload,
  Undo2,
  Redo2,
  Trash2,
  Scissors,
} from "lucide-react";
import { mapboxgl } from "@/lib/mapbox";
import { createMapboxMap } from "@/lib/mapboxMap";
import { useMapboxToken } from "@/hooks/useMapboxToken";
import { supabase } from "@/integrations/supabase/client";
import MapboxDraw from "@mapbox/mapbox-gl-draw";
import {
  type BoundarySetupMethod,
  type OfficialAdminLevel,
  type LatLng,
  OFFICIAL_ADMIN_LEVEL_LABELS,
  defaultBoundaryMethodForEntity,
  formatAreaSqMeters,
  geoJsonPolygonToLatLngRing,
  normalizeLatLngRing,
  parseImportedGeoJson,
  parseSimpleKmlPolygon,
  buildBoundaryPreviewSummary,
} from "../../../shared/adminBoundaryEditorSSOT";
import {
  clipBoundaryToParent,
  clipOverlapFromSibling,
  findServiceAreaOverlaps,
  generateRadiusPolygon,
  isBoundaryInsideParent,
  simplifyBoundaryForDisplay,
  summarizeBoundary,
  validateBoundaryGeometry,
  snapLatLngToBoundary,
  rectangleFromCorners,
  buildVertexFeatures,
  formatPerimeterMeters,
  geoJsonToZoneRings,
  zonesToCanonicalGeoBoundary,
} from "@/lib/adminBoundaryGeometry";
import { cn } from "@/lib/utils";
import { MAPBOX_STYLE } from "@/lib/mapbox";

const FILL_SRC = "abw-fill";
const FILL_LAYER = "abw-fill-layer";
const LINE_LAYER = "abw-line-layer";
const PARENT_SRC = "abw-parent";
const PARENT_FILL = "abw-parent-fill";
const PARENT_LINE = "abw-parent-line";
const PTS_SRC = "abw-pts";
const PTS_LAYER = "abw-pts-layer";
const SATELLITE_STYLE = "mapbox://styles/mapbox/satellite-streets-v12";

type SiblingArea = { id: string; name: string; geo_boundary: LatLng[] | null };
type DrawTool = "polygon" | "rectangle";

export type BoundaryOverlapPolicy = {
  allow: boolean;
  reason: string;
};

interface AdminBoundaryWorkspaceProps {
  entity: "region" | "service_area";
  boundary: LatLng[] | null;
  onBoundaryChange: (boundary: LatLng[]) => void;
  /** Optional: emit MultiPolygon / LatLng canonical payload for DB save. */
  onCanonicalBoundaryChange?: (canonical: LatLng[] | GeoJSON.MultiPolygon | null) => void;
  onOverlapPolicyChange?: (policy: BoundaryOverlapPolicy) => void;
  parentRegionBoundary?: LatLng[] | null;
  parentRegionName?: string | null;
  siblingServiceAreas?: SiblingArea[];
  editingServiceAreaId?: string | null;
  entityName?: string;
  height?: string;
  className?: string;
}

function toFeature(points: LatLng[]): GeoJSON.FeatureCollection {
  if (!points || points.length < 3) return { type: "FeatureCollection", features: [] };
  const ring = points.map((p) => [p.lng, p.lat]);
  ring.push(ring[0]);
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {},
        geometry: { type: "Polygon", coordinates: [ring] },
      },
    ],
  };
}

function pointsFc(points: LatLng[]): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: points.map((p, i) => ({
      type: "Feature",
      properties: { index: i + 1, outside: false },
      geometry: { type: "Point", coordinates: [p.lng, p.lat] },
    })),
  };
}

export function AdminBoundaryWorkspace({
  entity,
  boundary,
  onBoundaryChange,
  onCanonicalBoundaryChange,
  onOverlapPolicyChange,
  parentRegionBoundary = null,
  parentRegionName = null,
  siblingServiceAreas = [],
  editingServiceAreaId = null,
  entityName = "",
  height = "380px",
  className,
}: AdminBoundaryWorkspaceProps) {
  const [method, setMethod] = useState<BoundarySetupMethod>(
    defaultBoundaryMethodForEntity(entity),
  );
  const [points, setPoints] = useState<LatLng[]>(boundary || []);
  const [isDrawing, setIsDrawing] = useState(!boundary || boundary.length === 0);
  const [history, setHistory] = useState<LatLng[][]>([]);
  const [future, setFuture] = useState<LatLng[][]>([]);
  const [fullScreen, setFullScreen] = useState(false);
  const [pointerCoords, setPointerCoords] = useState<string>("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchResults, setSearchResults] = useState<Array<Record<string, unknown>>>([]);
  const [countries, setCountries] = useState<Array<{ country_code: string; country_name: string }>>([]);
  const [countryCode, setCountryCode] = useState(entity === "region" ? "SO" : "");
  const [adminLevel, setAdminLevel] = useState<OfficialAdminLevel>("country");
  const [catalogAreas, setCatalogAreas] = useState<Array<Record<string, unknown>>>([]);
  const [levels, setLevels] = useState<string[]>(["country"]);
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [radiusKm, setRadiusKm] = useState(5);
  const [radiusCenter, setRadiusCenter] = useState<LatLng | null>(null);
  const [overlapOverrideReason, setOverlapOverrideReason] = useState("");
  const [allowOverlap, setAllowOverlap] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [drawTool, setDrawTool] = useState<DrawTool>("polygon");
  const [snapEnabled, setSnapEnabled] = useState(entity === "service_area");
  const [mapStyleMode, setMapStyleMode] = useState<"street" | "satellite">("street");
  const [rectCorner, setRectCorner] = useState<LatLng | null>(null);
  const [extraZones, setExtraZones] = useState<LatLng[][]>([]);

  const containerRef = useRef<HTMLDivElement>(null);
  const fsContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const drawRef = useRef<MapboxDraw | null>(null);
  const searchMarkerRef = useRef<mapboxgl.Marker | null>(null);
  const activeContainerRef = useRef<HTMLDivElement | null>(null);
  const { isReady: mapboxReady, error: mapboxError } = useMapboxToken();
  const [mapLoaded, setMapLoaded] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);
  const [vertexEditMode, setVertexEditMode] = useState(false);
  const isDrawingRef = useRef(isDrawing);
  const methodRef = useRef(method);
  const drawToolRef = useRef(drawTool);
  const snapEnabledRef = useRef(snapEnabled);
  const rectCornerRef = useRef(rectCorner);
  const radiusKmRef = useRef(radiusKm);
  const parentBoundaryRef = useRef(parentRegionBoundary);
  useEffect(() => {
    isDrawingRef.current = isDrawing;
    methodRef.current = method;
    drawToolRef.current = drawTool;
    snapEnabledRef.current = snapEnabled;
    rectCornerRef.current = rectCorner;
    radiusKmRef.current = radiusKm;
    parentBoundaryRef.current = parentRegionBoundary;
  }, [isDrawing, method, drawTool, snapEnabled, rectCorner, radiusKm, parentRegionBoundary]);

  useEffect(() => {
    onOverlapPolicyChange?.({ allow: allowOverlap, reason: overlapOverrideReason });
  }, [allowOverlap, overlapOverrideReason, onOverlapPolicyChange]);

  const emitCanonical = useCallback(
    (primary: LatLng[], zones: LatLng[][] = extraZones) => {
      onCanonicalBoundaryChange?.(zonesToCanonicalGeoBoundary([primary, ...zones]));
    },
    [extraZones, onCanonicalBoundaryChange],
  );

  const normalized = useMemo(() => normalizeLatLngRing(points), [points]);
  const summary = useMemo(() => summarizeBoundary(normalized), [normalized]);
  const geomIssues = useMemo(() => validateBoundaryGeometry(normalized), [normalized]);
  const containment = useMemo(
    () =>
      entity === "service_area"
        ? isBoundaryInsideParent(normalized, parentRegionBoundary)
        : { inside: true, outsidePointCount: 0 },
    [entity, normalized, parentRegionBoundary],
  );
  const overlaps = useMemo(
    () =>
      entity === "service_area" && normalized.length >= 3
        ? findServiceAreaOverlaps(normalized, siblingServiceAreas, editingServiceAreaId)
        : [],
    [entity, normalized, siblingServiceAreas, editingServiceAreaId],
  );

  const pushHistory = useCallback((next: LatLng[]) => {
    setHistory((h) => [...h.slice(-49), points]);
    setFuture([]);
    setPoints(next);
  }, [points]);

  const commitBoundary = useCallback(
    (next: LatLng[]) => {
      const clean = normalizeLatLngRing(next);
      pushHistory(clean);
      onBoundaryChange(clean);
      emitCanonical(clean);
      setIsDrawing(false);
    },
    [onBoundaryChange, pushHistory, emitCanonical],
  );

  // Sync external boundary
  useEffect(() => {
    if (!boundary) return;
    const key = JSON.stringify(boundary);
    const cur = JSON.stringify(points);
    if (key !== cur) {
      setPoints(boundary);
      setIsDrawing(boundary.length === 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boundary]);

  const destroyMap = useCallback(() => {
    if (searchMarkerRef.current) {
      searchMarkerRef.current.remove();
      searchMarkerRef.current = null;
    }
    if (drawRef.current && mapRef.current) {
      try {
        mapRef.current.removeControl(drawRef.current as unknown as mapboxgl.IControl);
      } catch {
        /* already removed */
      }
      drawRef.current = null;
    }
    if (mapRef.current) {
      mapRef.current.remove();
      mapRef.current = null;
    }
    setMapLoaded(false);
    setVertexEditMode(false);
  }, []);

  const paintMap = useCallback(
    (map: mapboxgl.Map, pts: LatLng[]) => {
      const fill = map.getSource(FILL_SRC) as mapboxgl.GeoJSONSource | undefined;
      const ptsSrc = map.getSource(PTS_SRC) as mapboxgl.GeoJSONSource | undefined;
      const parent = map.getSource(PARENT_SRC) as mapboxgl.GeoJSONSource | undefined;
      const allZones = [pts, ...extraZones].filter((z) => z.length >= 3);
      if (allZones.length <= 1) {
        fill?.setData(toFeature(pts));
      } else {
        const features = allZones.map((z) => {
          const ring = z.map((p) => [p.lng, p.lat]);
          ring.push(ring[0]);
          return {
            type: "Feature" as const,
            properties: {},
            geometry: { type: "Polygon" as const, coordinates: [ring] },
          };
        });
        fill?.setData({ type: "FeatureCollection", features });
      }
      ptsSrc?.setData(buildVertexFeatures(pts, parentRegionBoundary));
      if (parent && parentRegionBoundary) {
        parent.setData(toFeature(parentRegionBoundary));
      }
    },
    [parentRegionBoundary, extraZones],
  );

  const stopVertexEdit = useCallback(() => {
    const map = mapRef.current;
    if (drawRef.current && map) {
      try {
        map.removeControl(drawRef.current as unknown as mapboxgl.IControl);
      } catch {
        /* ignore */
      }
      drawRef.current = null;
    }
    setVertexEditMode(false);
    if (map?.getLayer(FILL_LAYER)) map.setLayoutProperty(FILL_LAYER, "visibility", "visible");
    if (map?.getLayer(LINE_LAYER)) map.setLayoutProperty(LINE_LAYER, "visibility", "visible");
    if (map?.getLayer(PTS_LAYER)) map.setLayoutProperty(PTS_LAYER, "visibility", "visible");
    if (map) paintMap(map, points);
  }, [paintMap, points]);

  const startVertexEdit = useCallback(() => {
    const map = mapRef.current;
    const ring = normalizeLatLngRing(points);
    if (!map || ring.length < 3) return;

    if (drawRef.current) {
      try {
        map.removeControl(drawRef.current as unknown as mapboxgl.IControl);
      } catch {
        /* ignore */
      }
      drawRef.current = null;
    }

    const draw = new MapboxDraw({
      displayControlsDefault: false,
      controls: { trash: true },
      defaultMode: "simple_select",
    });
    map.addControl(draw as unknown as mapboxgl.IControl);
    drawRef.current = draw;

    if (map.getLayer(FILL_LAYER)) map.setLayoutProperty(FILL_LAYER, "visibility", "none");
    if (map.getLayer(LINE_LAYER)) map.setLayoutProperty(LINE_LAYER, "visibility", "none");
    if (map.getLayer(PTS_LAYER)) map.setLayoutProperty(PTS_LAYER, "visibility", "none");

    const closed = ring.map((p) => [p.lng, p.lat] as [number, number]);
    closed.push([ring[0].lng, ring[0].lat]);
    const ids = draw.add({
      type: "Feature",
      properties: {},
      geometry: { type: "Polygon", coordinates: [closed] },
    });
    const featureId = Array.isArray(ids) ? ids[0] : ids;
    draw.changeMode("direct_select", { featureId });

    const syncFromDraw = () => {
      const data = draw.getAll();
      const f = data.features[0];
      if (!f || f.geometry.type !== "Polygon") return;
      const next = geoJsonPolygonToLatLngRing(f.geometry);
      if (!next) return;
      setPoints(next);
      onBoundaryChange(next);
      emitCanonical(next);
    };
    map.on("draw.update", syncFromDraw);
    map.on("draw.delete", () => {
      setPoints([]);
      onBoundaryChange([]);
      emitCanonical([]);
      setVertexEditMode(false);
      drawRef.current = null;
      if (map.getLayer(FILL_LAYER)) map.setLayoutProperty(FILL_LAYER, "visibility", "visible");
      if (map.getLayer(LINE_LAYER)) map.setLayoutProperty(LINE_LAYER, "visibility", "visible");
      if (map.getLayer(PTS_LAYER)) map.setLayoutProperty(PTS_LAYER, "visibility", "visible");
    });

    setIsDrawing(false);
    setVertexEditMode(true);
  }, [points, onBoundaryChange, emitCanonical]);

  const initMap = useCallback(
    async (container: HTMLDivElement) => {
      if (!mapboxReady || !container) return;
      destroyMap();
      activeContainerRef.current = container;
      const center: [number, number] =
        points.length > 0
          ? [points[0].lng, points[0].lat]
          : parentRegionBoundary && parentRegionBoundary.length > 0
            ? [parentRegionBoundary[0].lng, parentRegionBoundary[0].lat]
            : [45.3, 2.0]; // Horn of Africa default for Africa launches

      try {
        const { map } = await createMapboxMap({
          container,
          center,
          zoom: points.length > 0 ? 8 : 5,
          onLoad: (m) => {
            m.addSource(PARENT_SRC, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
            m.addLayer({
              id: PARENT_FILL,
              type: "fill",
              source: PARENT_SRC,
              paint: { "fill-color": "#64748b", "fill-opacity": 0.08 },
            });
            m.addLayer({
              id: PARENT_LINE,
              type: "line",
              source: PARENT_SRC,
              paint: { "line-color": "#64748b", "line-width": 2, "line-dasharray": [2, 2] },
            });
            m.addSource(FILL_SRC, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
            m.addLayer({
              id: FILL_LAYER,
              type: "fill",
              source: FILL_SRC,
              paint: { "fill-color": "#f97316", "fill-opacity": 0.22 },
            });
            m.addLayer({
              id: LINE_LAYER,
              type: "line",
              source: FILL_SRC,
              paint: { "line-color": "#ea580c", "line-width": 2.5 },
            });
            m.addSource(PTS_SRC, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
            m.addLayer({
              id: PTS_LAYER,
              type: "circle",
              source: PTS_SRC,
              paint: {
                "circle-radius": 7,
                "circle-color": [
                  "case",
                  ["get", "outside"],
                  "#ef4444",
                  "#ea580c",
                ],
                "circle-stroke-color": [
                  "case",
                  ["get", "outside"],
                  "#991b1b",
                  "#9a3412",
                ],
                "circle-stroke-width": 2,
              },
            });
            paintMap(m, points);
            if (points.length >= 3) {
              const b = new mapboxgl.LngLatBounds();
              points.forEach((p) => b.extend([p.lng, p.lat]));
              m.fitBounds(b, { padding: 48, maxZoom: 12 });
            } else if (parentRegionBoundary && parentRegionBoundary.length >= 3) {
              const b = new mapboxgl.LngLatBounds();
              parentRegionBoundary.forEach((p) => b.extend([p.lng, p.lat]));
              m.fitBounds(b, { padding: 48, maxZoom: 10 });
            }
            setMapLoaded(true);
          },
        });
        map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), "top-right");
        map.addControl(new mapboxgl.FullscreenControl(), "top-right");
        map.addControl(new mapboxgl.ScaleControl({ unit: "metric" }), "bottom-left");

        map.on("mousemove", (e) => {
          setPointerCoords(`${e.lngLat.lat.toFixed(5)}, ${e.lngLat.lng.toFixed(5)}`);
        });

        map.on("click", (e) => {
          if (!isDrawingRef.current) return;
          let clickPt = { lat: e.lngLat.lat, lng: e.lngLat.lng };
          const parentB = parentBoundaryRef.current;
          if (snapEnabledRef.current && parentB && parentB.length >= 2) {
            clickPt = snapLatLngToBoundary(clickPt, parentB);
          }
          if (methodRef.current === "radius") {
            setRadiusCenter(clickPt);
            const ring = generateRadiusPolygon(clickPt, radiusKmRef.current);
            setPoints(ring);
            paintMap(map, ring);
            return;
          }
          if (methodRef.current !== "draw") return;
          if (drawToolRef.current === "rectangle") {
            if (!rectCornerRef.current) {
              setRectCorner(clickPt);
              return;
            }
            const rect = rectangleFromCorners(rectCornerRef.current, clickPt);
            setRectCorner(null);
            setPoints(rect);
            paintMap(map, rect);
            return;
          }
          setPoints((prev) => {
            const next = [...prev, clickPt];
            paintMap(map, next);
            return next;
          });
        });

        mapRef.current = map;
      } catch (err) {
        setMapError(err instanceof Error ? err.message : "Map failed to load");
      }
    },
    [destroyMap, mapboxReady, paintMap, parentRegionBoundary, points],
  );

  useEffect(() => {
    if (!mapboxReady) return;
    const el = fullScreen ? fsContainerRef.current : containerRef.current;
    if (!el) return;
    void initMap(el);
    return () => destroyMap();
    // re-init when fullscreen toggles
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapboxReady, fullScreen]);

  useEffect(() => {
    if (mapRef.current && mapLoaded) paintMap(mapRef.current, points);
  }, [points, mapLoaded, paintMap]);

  useEffect(() => {
    void (async () => {
      const { data, error } = await supabase.functions.invoke("admin-official-boundaries", {
        body: { action: "list_countries" },
      });
      if (!error && data?.countries) setCountries(data.countries);
    })();
  }, []);

  useEffect(() => {
    if (!countryCode) return;
    void (async () => {
      setCatalogBusy(true);
      try {
        const [{ data: lvl }, { data: areas }] = await Promise.all([
          supabase.functions.invoke("admin-official-boundaries", {
            body: { action: "list_levels", country_code: countryCode },
          }),
          supabase.functions.invoke("admin-official-boundaries", {
            body: { action: "list_areas", country_code: countryCode, admin_level: adminLevel },
          }),
        ]);
        if (lvl?.levels?.length) setLevels(lvl.levels);
        setCatalogAreas(areas?.areas || []);
      } finally {
        setCatalogBusy(false);
      }
    })();
  }, [countryCode, adminLevel]);

  const applyOfficialGeoJson = useCallback(
    (geojson: GeoJSON.Polygon | GeoJSON.MultiPolygon, zoom = true) => {
      const zones = geoJsonToZoneRings(geojson);
      if (!zones.length) return;
      const [primary, ...rest] = zones;
      setExtraZones(rest);
      commitBoundary(primary);
      setIsDrawing(false);
      if (zoom && mapRef.current) {
        const b = new mapboxgl.LngLatBounds();
        zones.flat().forEach((p) => b.extend([p.lng, p.lat]));
        mapRef.current.fitBounds(b, { padding: 48, maxZoom: 12 });
      }
    },
    [commitBoundary],
  );

  const loadCatalogArea = async (id: string) => {
    setCatalogBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke("admin-official-boundaries", {
        body: { action: "get_area", id },
      });
      if (error || !data?.area?.geojson) throw new Error(data?.error || error?.message || "Load failed");
      applyOfficialGeoJson(data.area.geojson);
    } finally {
      setCatalogBusy(false);
    }
  };

  const runSearch = async () => {
    if (searchQuery.trim().length < 2) return;
    setSearchBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke("admin-official-boundaries", {
        body: {
          action: "search",
          query: searchQuery.trim(),
          country_code: countryCode || undefined,
        },
      });
      if (error) throw error;
      setSearchResults(data?.results || []);
      // Fly to first geocoded result center if map ready
      const first = (data?.results || [])[0];
      if (first?.geojson && mapRef.current) {
        const ring = geoJsonPolygonToLatLngRing(first.geojson as GeoJSON.Polygon);
        if (ring?.[0]) {
          mapRef.current.flyTo({ center: [ring[0].lng, ring[0].lat], zoom: 10 });
          if (searchMarkerRef.current) searchMarkerRef.current.remove();
          searchMarkerRef.current = new mapboxgl.Marker({ color: "#ea580c" })
            .setLngLat([ring[0].lng, ring[0].lat])
            .addTo(mapRef.current);
        }
      }
    } finally {
      setSearchBusy(false);
    }
  };

  const onImportFile = async (file: File) => {
    setImportError(null);
    const text = await file.text();
    const lower = file.name.toLowerCase();
    let parsed =
      lower.endsWith(".kml") || text.includes("<kml")
        ? parseSimpleKmlPolygon(text)
        : parseImportedGeoJson(text);
    if (!parsed.ok) {
      setImportError((parsed as { ok: false; message: string }).message);
      return;
    }
    applyOfficialGeoJson((parsed as { ok: true; geometry: GeoJSON.MultiPolygon | GeoJSON.Polygon }).geometry);
  };

  const undo = () => {
    if (!history.length) return;
    const prev = history[history.length - 1];
    setFuture((f) => [points, ...f]);
    setHistory((h) => h.slice(0, -1));
    setPoints(prev);
    onBoundaryChange(prev);
  };

  const redo = () => {
    if (!future.length) return;
    const [next, ...rest] = future;
    setHistory((h) => [...h, points]);
    setFuture(rest);
    setPoints(next);
    onBoundaryChange(next);
  };

  const clearAll = () => {
    pushHistory([]);
    setExtraZones([]);
    onBoundaryChange([]);
    onCanonicalBoundaryChange?.(null);
    setIsDrawing(true);
    setRadiusCenter(null);
    setRectCorner(null);
  };

  const finishDrawing = () => {
    if (normalized.length < 3) return;
    commitBoundary(normalized);
  };

  const clipToParent = () => {
    if (!parentRegionBoundary) return;
    const clipped = clipBoundaryToParent(normalized, parentRegionBoundary);
    if (clipped) commitBoundary(clipped);
  };

  const validationPassed =
    geomIssues.filter((i) => i.severity === "error").length === 0 &&
    (entity !== "service_area" || containment.inside) &&
    (overlaps.length === 0 || (allowOverlap && overlapOverrideReason.trim().length >= 8));

  const previewLines = buildBoundaryPreviewSummary({
    name: entityName,
    parentRegionName,
    method,
    pointCount: summary.pointCount,
    areaLabel: formatAreaSqMeters(summary.areaSqMeters),
    insideParent: entity === "service_area" ? containment.inside : null,
    overlapLabel:
      overlaps.length === 0
        ? "No"
        : overlaps.map((o) => `${o.overlapPercent}% with ${o.name}`).join("; "),
    validationPassed,
  });

  const methodButtons: Array<{ id: BoundarySetupMethod; label: string; show: boolean }> = [
    { id: "official", label: "Select official boundary", show: true },
    { id: "draw", label: "Draw on map", show: true },
    { id: "import", label: "Import file", show: true },
    { id: "radius", label: "Radius around centre", show: entity === "service_area" },
    { id: "copy", label: "Copy existing Service Area", show: entity === "service_area" },
  ];

  const editorChrome = (fullscreen: boolean) => (
    <div className={cn("space-y-3", fullscreen && "h-full flex flex-col")}>
      <div>
        <Label className="text-sm font-medium">Boundary setup</Label>
        <div className="mt-2 flex flex-wrap gap-2">
          {methodButtons
            .filter((b) => b.show)
            .map((b) => (
              <Button
                key={b.id}
                type="button"
                size="sm"
                variant={method === b.id ? "default" : "outline"}
                onClick={() => {
                  setMethod(b.id);
                  if (b.id === "draw" || b.id === "radius") setIsDrawing(true);
                }}
              >
                {b.label}
              </Button>
            ))}
        </div>
        {entity === "region" && method === "official" && (
          <p className="mt-2 text-xs text-muted-foreground">
            Default for Regions: pick an official country or admin boundary — do not manually trace coastlines.
          </p>
        )}
      </div>

      {method === "official" && (
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1">
            <Label>Country</Label>
            <Select value={countryCode} onValueChange={setCountryCode}>
              <SelectTrigger>
                <SelectValue placeholder="Select country" />
              </SelectTrigger>
              <SelectContent>
                {countries.map((c) => (
                  <SelectItem key={c.country_code} value={c.country_code}>
                    {c.country_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Administrative level</Label>
            <Select value={adminLevel} onValueChange={(v) => setAdminLevel(v as OfficialAdminLevel)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(levels.length ? levels : Object.keys(OFFICIAL_ADMIN_LEVEL_LABELS)).map((lvl) => (
                  <SelectItem key={lvl} value={lvl}>
                    {OFFICIAL_ADMIN_LEVEL_LABELS[lvl as OfficialAdminLevel] || lvl}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Official area</Label>
            <Select
              onValueChange={(id) => {
                void loadCatalogArea(id);
              }}
              disabled={catalogBusy || catalogAreas.length === 0}
            >
              <SelectTrigger>
                <SelectValue placeholder={catalogBusy ? "Loading…" : catalogAreas.length ? "Select area" : "No catalog areas"} />
              </SelectTrigger>
              <SelectContent>
                {catalogAreas.map((a) => (
                  <SelectItem key={String(a.id)} value={String(a.id)}>
                    {String(a.name)}
                    {a.point_count ? ` (${a.point_count} pts)` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      )}

      {method === "import" && (
        <div className="space-y-2 rounded-lg border p-3">
          <Label className="flex items-center gap-2">
            <Upload className="h-4 w-4" /> Import GeoJSON / KML
          </Label>
          <Input
            type="file"
            accept=".json,.geojson,.kml,application/geo+json,application/json,application/vnd.google-earth.kml+xml"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onImportFile(f);
            }}
          />
          {importError && <p className="text-sm text-destructive">{importError}</p>}
          <p className="text-xs text-muted-foreground">
            Geometry is validated before apply. Shapefile zip support can be added later.
          </p>
        </div>
      )}

      {method === "radius" && (
        <div className="flex flex-wrap items-end gap-3 rounded-lg border p-3">
          <div className="space-y-1">
            <Label>Radius (km)</Label>
            <Input
              type="number"
              min={0.5}
              max={200}
              step={0.5}
              value={radiusKm}
              onChange={(e) => setRadiusKm(Number(e.target.value) || 5)}
              className="w-28"
            />
          </div>
          <p className="text-sm text-muted-foreground">
            Click the map to set the centre
            {radiusCenter ? ` (${radiusCenter.lat.toFixed(4)}, ${radiusCenter.lng.toFixed(4)})` : ""}.
          </p>
          <Button
            type="button"
            size="sm"
            disabled={!radiusCenter}
            onClick={() => {
              if (!radiusCenter) return;
              commitBoundary(generateRadiusPolygon(radiusCenter, radiusKm));
            }}
          >
            Generate circular polygon
          </Button>
        </div>
      )}

      {method === "copy" && entity === "service_area" && (
        <div className="space-y-2 rounded-lg border p-3">
          <Label>Copy existing Service Area and edit</Label>
          <Select
            onValueChange={(id) => {
              const src = siblingServiceAreas.find((s) => s.id === id);
              if (src?.geo_boundary) {
                commitBoundary(src.geo_boundary);
                setExtraZones([]);
                setMethod("draw");
                setIsDrawing(true);
              }
            }}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select a Service Area to copy" />
            </SelectTrigger>
            <SelectContent>
              {siblingServiceAreas
                .filter((s) => s.id !== editingServiceAreaId && s.geo_boundary && s.geo_boundary.length >= 3)
                .map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {method === "draw" && (
        <div className="flex flex-wrap gap-2 items-center">
          <Button
            type="button"
            size="sm"
            variant={drawTool === "polygon" ? "default" : "outline"}
            onClick={() => {
              setDrawTool("polygon");
              setRectCorner(null);
              setIsDrawing(true);
            }}
          >
            Draw polygon
          </Button>
          <Button
            type="button"
            size="sm"
            variant={drawTool === "rectangle" ? "default" : "outline"}
            onClick={() => {
              setDrawTool("rectangle");
              setRectCorner(null);
              setIsDrawing(true);
            }}
          >
            Draw rectangle
          </Button>
          {entity === "service_area" && (
            <label className="flex items-center gap-2 text-sm ml-2">
              <input
                type="checkbox"
                checked={snapEnabled}
                onChange={(e) => setSnapEnabled(e.target.checked)}
              />
              Snap to parent Region boundary
            </label>
          )}
          {rectCorner && (
            <span className="text-xs text-muted-foreground">Click opposite corner to finish rectangle</span>
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            className="pl-8"
            placeholder="Search country, city, district or landmark"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void runSearch();
              }
            }}
          />
        </div>
        <Button type="button" variant="secondary" onClick={() => void runSearch()} disabled={searchBusy}>
          {searchBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Search"}
        </Button>
        {!fullscreen && (
          <Button type="button" variant="outline" onClick={() => setFullScreen(true)}>
            <Expand className="mr-2 h-4 w-4" />
            Open Full-Screen Editor
          </Button>
        )}
      </div>

      {searchResults.length > 0 && (
        <div className="max-h-36 overflow-y-auto rounded-md border divide-y">
          {searchResults.map((r) => (
            <button
              key={String(r.id)}
              type="button"
              className="w-full px-3 py-2 text-left text-sm hover:bg-muted/60"
              onClick={() => {
                if (r.geojson) applyOfficialGeoJson(r.geojson as GeoJSON.Polygon | GeoJSON.MultiPolygon);
                setSearchResults([]);
              }}
            >
              <span className="font-medium">{String(r.name)}</span>
              <span className="ml-2 text-xs text-muted-foreground">
                {String(r.admin_level)} · {String(r.source)}
              </span>
              <div className="text-xs text-muted-foreground truncate">{String(r.display_name)}</div>
            </button>
          ))}
        </div>
      )}

      <div
        className={cn("relative w-full overflow-hidden rounded-lg border bg-muted/20", fullscreen && "flex-1 min-h-0")}
        style={fullscreen ? undefined : { height }}
      >
        <div
          ref={fullscreen ? fsContainerRef : containerRef}
          className="absolute inset-0"
        />
        {(mapboxError || mapError) && (
          <div className="absolute inset-0 flex items-center justify-center bg-background/80 p-4 text-sm text-destructive">
            {mapboxError || mapError}
          </div>
        )}
        <div className="pointer-events-none absolute bottom-2 right-2 rounded bg-background/90 px-2 py-1 text-[11px] text-muted-foreground">
          {pointerCoords || "—"}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="outline" onClick={undo} disabled={!history.length}>
          <Undo2 className="mr-1 h-4 w-4" /> Undo
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={redo} disabled={!future.length}>
          <Redo2 className="mr-1 h-4 w-4" /> Redo
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={clearAll}>
          <Trash2 className="mr-1 h-4 w-4" /> Clear
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            if (normalized.length === 0) return;
            const next = normalized.slice(0, -1);
            pushHistory(next);
            onBoundaryChange(next);
            emitCanonical(next);
          }}
          disabled={normalized.length === 0}
        >
          Delete last point
        </Button>
        {isDrawing && (
          <Button type="button" size="sm" onClick={finishDrawing} disabled={normalized.length < 3}>
            Finish drawing
          </Button>
        )}
        {!isDrawing && !vertexEditMode && normalized.length >= 3 && (
          <Button type="button" size="sm" variant="secondary" onClick={() => startVertexEdit()}>
            Edit boundary (drag / midpoints)
          </Button>
        )}
        {vertexEditMode && (
          <Button type="button" size="sm" onClick={() => stopVertexEdit()}>
            Finish vertex edit
          </Button>
        )}
        {!isDrawing && !vertexEditMode && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              stopVertexEdit();
              setIsDrawing(true);
            }}
          >
            Add points
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => commitBoundary(simplifyBoundaryForDisplay(normalized, 0.002))}
          disabled={normalized.length < 3}
        >
          Simplify display
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            if (normalized.length < 3) return;
            setExtraZones((z) => [...z, normalized]);
            setPoints([]);
            setIsDrawing(true);
            onBoundaryChange([]);
          }}
          disabled={normalized.length < 3}
        >
          Add another zone
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            if (!mapRef.current || !parentRegionBoundary || parentRegionBoundary.length < 3) return;
            const b = new mapboxgl.LngLatBounds();
            parentRegionBoundary.forEach((p) => b.extend([p.lng, p.lat]));
            mapRef.current.fitBounds(b, { padding: 48, maxZoom: 10 });
          }}
          disabled={!parentRegionBoundary || parentRegionBoundary.length < 3}
        >
          Fit parent Region
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            if (!mapRef.current || normalized.length < 1) return;
            const b = new mapboxgl.LngLatBounds();
            [...normalized, ...extraZones.flat()].forEach((p) => b.extend([p.lng, p.lat]));
            mapRef.current.fitBounds(b, { padding: 48, maxZoom: 12 });
          }}
          disabled={normalized.length < 1}
        >
          Fit current polygon
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            const next = mapStyleMode === "street" ? "satellite" : "street";
            setMapStyleMode(next);
            mapRef.current?.setStyle(next === "satellite" ? SATELLITE_STYLE : MAPBOX_STYLE);
            // Re-add layers after style load
            mapRef.current?.once("style.load", () => {
              const m = mapRef.current;
              if (!m) return;
              if (!m.getSource(PARENT_SRC)) {
                m.addSource(PARENT_SRC, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
                m.addLayer({ id: PARENT_FILL, type: "fill", source: PARENT_SRC, paint: { "fill-color": "#64748b", "fill-opacity": 0.08 } });
                m.addLayer({ id: PARENT_LINE, type: "line", source: PARENT_SRC, paint: { "line-color": "#64748b", "line-width": 2, "line-dasharray": [2, 2] } });
                m.addSource(FILL_SRC, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
                m.addLayer({ id: FILL_LAYER, type: "fill", source: FILL_SRC, paint: { "fill-color": "#f97316", "fill-opacity": 0.22 } });
                m.addLayer({ id: LINE_LAYER, type: "line", source: FILL_SRC, paint: { "line-color": "#ea580c", "line-width": 2.5 } });
                m.addSource(PTS_SRC, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
                m.addLayer({
                  id: PTS_LAYER,
                  type: "circle",
                  source: PTS_SRC,
                  paint: {
                    "circle-radius": 7,
                    "circle-color": ["case", ["get", "outside"], "#ef4444", "#ea580c"],
                    "circle-stroke-color": ["case", ["get", "outside"], "#991b1b", "#9a3412"],
                    "circle-stroke-width": 2,
                  },
                });
              }
              paintMap(m, points);
            });
          }}
        >
          {mapStyleMode === "street" ? "Satellite" : "Street"}
        </Button>
        {entity === "service_area" && !containment.inside && (
          <Button type="button" size="sm" variant="destructive" onClick={clipToParent}>
            <Scissors className="mr-1 h-4 w-4" /> Clip to parent Region
          </Button>
        )}
        <Badge variant="secondary">{summary.pointCount} points</Badge>
        <Badge variant="outline">{formatAreaSqMeters(summary.areaSqMeters)}</Badge>
        <Badge variant="outline">{formatPerimeterMeters(summary.perimeterMeters)}</Badge>
        {extraZones.length > 0 && (
          <Badge variant="secondary">{extraZones.length + 1} zones (MultiPolygon)</Badge>
        )}
        {normalized.length >= 3 ? (
          <span className="text-sm text-green-600 flex items-center gap-1">
            <CheckCircle2 className="h-4 w-4" /> Boundary ready
          </span>
        ) : (
          <span className="text-sm text-muted-foreground flex items-center gap-1">
            <MapPin className="h-4 w-4" /> Add or select a boundary
          </span>
        )}
      </div>

      {geomIssues.map((issue) => (
        <div key={issue.code + issue.message} className="flex items-start gap-2 text-sm text-destructive">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          {issue.message}
        </div>
      ))}

      {entity === "service_area" && !containment.inside && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          Outside parent Region: {containment.outsidePointCount} vertex(es). Clip before saving.
        </div>
      )}

      {overlaps.length > 0 && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 space-y-2 text-sm">
          <p className="font-medium">Overlap detected</p>
          {overlaps.map((o) => (
            <p key={o.id}>
              {o.overlapPercent}% overlaps with {o.name}
            </p>
          ))}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                const top = overlaps[0];
                const sibling = siblingServiceAreas.find((s) => s.id === top.id);
                if (!sibling?.geo_boundary) return;
                const clipped = clipOverlapFromSibling(normalized, sibling.geo_boundary);
                if (clipped) commitBoundary(clipped);
              }}
            >
              <Scissors className="mr-1 h-4 w-4" /> Clip overlap
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => startVertexEdit()}>
              Edit boundary
            </Button>
          </div>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={allowOverlap}
              onChange={(e) => setAllowOverlap(e.target.checked)}
            />
            Allow overlap with mandatory reason
          </label>
          {allowOverlap && (
            <Input
              placeholder="Why is overlap intentional?"
              value={overlapOverrideReason}
              onChange={(e) => setOverlapOverrideReason(e.target.value)}
            />
          )}
        </div>
      )}

      {normalized.length >= 3 && (
        <div className="rounded-lg border bg-muted/30 p-3 text-sm space-y-1">
          <p className="font-medium">Boundary Summary</p>
          {previewLines.map((line) => (
            <p key={line} className="text-muted-foreground">
              {line}
            </p>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <div className={className}>
      {!fullScreen && editorChrome(false)}
      <Dialog open={fullScreen} onOpenChange={setFullScreen}>
        <DialogContent className="max-w-[98vw] w-[98vw] h-[96vh] flex flex-col p-4">
          <DialogHeader>
            <DialogTitle>Full-Screen Boundary Editor</DialogTitle>
            <DialogDescription>
              Draw or select official boundaries on a large Mapbox map. Done returns to the form with the current boundary.
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 min-h-0 overflow-y-auto pr-1">{fullScreen ? editorChrome(true) : null}</div>
          <div className="flex justify-end gap-2 pt-2 border-t">
            <Button type="button" variant="outline" onClick={() => setFullScreen(false)}>
              Done
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
