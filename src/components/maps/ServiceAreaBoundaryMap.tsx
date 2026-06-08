import { useEffect, useRef, useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Trash2, Undo, MapPin, AlertTriangle, Check, Ruler } from 'lucide-react';
import * as turf from '@turf/turf';
import { mapboxgl } from '@/lib/mapbox';
import { createMapboxMap } from '@/lib/mapboxMap';
import { useMapboxToken } from '@/hooks/useMapboxToken';

interface LatLng { lat: number; lng: number }
interface GeoJSONPoly { type: string; coordinates: number[][][] }
interface RegionBoundary {
  id: string;
  name: string;
  geo_boundary: GeoJSONPoly | LatLng[] | null;
}
interface ServiceAreaBoundaryMapProps {
  boundary: GeoJSONPoly | LatLng[] | null;
  region: RegionBoundary | null;
  onBoundaryChange: (boundary: GeoJSONPoly | null) => void;
  isEditable?: boolean;
  height?: string;
}

function normalizeToLatLng(boundary: GeoJSONPoly | LatLng[] | null): LatLng[] {
  if (!boundary) return [];
  if (Array.isArray(boundary) && boundary.length > 0 && 'lat' in boundary[0]) return boundary as LatLng[];
  if (typeof boundary === 'object' && 'coordinates' in boundary) {
    const coords = (boundary as GeoJSONPoly).coordinates?.[0];
    if (coords) return coords.slice(0, -1).map((c) => ({ lat: c[1], lng: c[0] }));
  }
  return [];
}

function latLngToGeoJSON(points: LatLng[]): GeoJSONPoly | null {
  if (points.length < 3) return null;
  const ring = points.map((p) => [p.lng, p.lat]);
  ring.push(ring[0]);
  return { type: 'Polygon', coordinates: [ring] };
}

const REGION_SRC = 'sa-region-src', REGION_FILL = 'sa-region-fill', REGION_LINE = 'sa-region-line';
const SA_SRC = 'sa-src', SA_FILL = 'sa-fill', SA_LINE = 'sa-line';
const PTS_SRC = 'sa-points-src', PTS_LAYER = 'sa-points', PTS_LABELS = 'sa-points-labels';

export function ServiceAreaBoundaryMap({
  boundary,
  region,
  onBoundaryChange,
  isEditable = true,
  height = '400px',
}: ServiceAreaBoundaryMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const { isReady: mapboxReady, error: mapboxError } = useMapboxToken();
  const [isMapLoaded, setIsMapLoaded] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);
  const mapInitError = mapboxError ?? mapError;
  const [points, setPoints] = useState<LatLng[]>([]);
  const [isDrawing, setIsDrawing] = useState(true);
  const [validationWarning, setValidationWarning] = useState<string | null>(null);
  const boundaryInitializedRef = useRef(false);
  const internalUpdateRef = useRef(false);
  const isDrawingRef = useRef(isDrawing);
  useEffect(() => { isDrawingRef.current = isDrawing; }, [isDrawing]);

  // Init from boundary prop
  useEffect(() => {
    if (internalUpdateRef.current) {
      internalUpdateRef.current = false;
      return;
    }
    const normalized = normalizeToLatLng(boundary);
    if (normalized.length >= 3) {
      setPoints(normalized);
      setIsDrawing(false);
      boundaryInitializedRef.current = true;
    } else if (!boundaryInitializedRef.current) {
      setPoints([]);
      setIsDrawing(true);
    }
  }, [boundary]);

  const regionBoundary = normalizeToLatLng(region?.geo_boundary || null);

  const getMapCenter = useCallback((): [number, number] => {
    if (regionBoundary.length > 0) {
      const lat = regionBoundary.reduce((s, p) => s + p.lat, 0) / regionBoundary.length;
      const lng = regionBoundary.reduce((s, p) => s + p.lng, 0) / regionBoundary.length;
      return [lng, lat];
    }
    return [-0.1278, 51.5074];
  }, [regionBoundary]);

  // Init Mapbox after web token resolves
  useEffect(() => {
    if (!mapboxReady || !containerRef.current || mapRef.current) return;

    let cancelled = false;
    let detachResize: (() => void) | undefined;

    void (async () => {
      try {
        const { map, detachResize: detach } = await createMapboxMap({
          container: containerRef.current!,
          center: getMapCenter(),
          zoom: 11,
          onLoad: (m) => {
            if (cancelled) return;
            m.addSource(REGION_SRC, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
            m.addLayer({ id: REGION_FILL, type: 'fill', source: REGION_SRC, paint: { 'fill-color': '#6B7280', 'fill-opacity': 0.05 } });
            m.addLayer({ id: REGION_LINE, type: 'line', source: REGION_SRC, paint: { 'line-color': '#6B7280', 'line-width': 2, 'line-dasharray': [4, 2] } });

            m.addSource(SA_SRC, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
            m.addLayer({ id: SA_FILL, type: 'fill', source: SA_SRC, paint: { 'fill-color': '#10b981', 'fill-opacity': 0.2 } });
            m.addLayer({ id: SA_LINE, type: 'line', source: SA_SRC, paint: { 'line-color': '#10b981', 'line-width': 2 } });

            m.addSource(PTS_SRC, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
            m.addLayer({
              id: PTS_LAYER, type: 'circle', source: PTS_SRC,
              paint: {
                'circle-radius': 9,
                'circle-color': ['case', ['==', ['get', 'inside'], false], '#ef4444', '#10b981'],
                'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2,
              },
            });
            m.addLayer({
              id: PTS_LABELS, type: 'symbol', source: PTS_SRC,
              layout: { 'text-field': ['get', 'index'], 'text-size': 11, 'text-allow-overlap': true },
              paint: { 'text-color': '#ffffff' },
            });

            setIsMapLoaded(true);
          },
          onTileError: (msg) => {
            if (!cancelled) {
              setMapError(msg);
              setIsMapLoaded(true);
            }
          },
        });
        if (cancelled) {
          map.remove();
          detach();
          return;
        }
        map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'top-left');
        map.addControl(new mapboxgl.FullscreenControl(), 'top-right');
        map.on('click', (e) => {
          if (!isDrawingRef.current) return;
          setPoints((prev) => [...prev, { lat: e.lngLat.lat, lng: e.lngLat.lng }]);
        });
        detachResize = detach;
        mapRef.current = map;
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : 'Failed to initialize map';
        setMapError(msg);
        setIsMapLoaded(true);
      }
    })();

    return () => {
      cancelled = true;
      detachResize?.();
      mapRef.current?.remove();
      mapRef.current = null;
      setIsMapLoaded(false);
    };
  }, [mapboxReady]); // eslint-disable-line react-hooks/exhaustive-deps

  // Render region polygon + fit bounds
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isMapLoaded) return;
    const src = map.getSource(REGION_SRC) as mapboxgl.GeoJSONSource | undefined;
    if (regionBoundary.length >= 3) {
      const feat = latLngToGeoJSON(regionBoundary);
      src?.setData({ type: 'FeatureCollection', features: feat ? [{ type: 'Feature', properties: {}, geometry: feat as GeoJSON.Polygon }] : [] });
      const bounds = new mapboxgl.LngLatBounds();
      regionBoundary.forEach((p) => bounds.extend([p.lng, p.lat]));
      map.fitBounds(bounds, { padding: 50, animate: false });
    } else {
      src?.setData({ type: 'FeatureCollection', features: [] });
    }
  }, [isMapLoaded, region]); // eslint-disable-line react-hooks/exhaustive-deps

  const isPointInRegion = useCallback((point: LatLng): boolean => {
    if (regionBoundary.length < 3) return true;
    const ring = regionBoundary.map((p) => [p.lng, p.lat]);
    ring.push(ring[0]);
    const poly = turf.polygon([ring]);
    return turf.booleanPointInPolygon(turf.point([point.lng, point.lat]), poly);
  }, [regionBoundary]);

  // Validate
  useEffect(() => {
    if (points.length >= 3) {
      const outside = points.filter((p) => !isPointInRegion(p));
      setValidationWarning(outside.length > 0 ? `${outside.length} point(s) are outside the region boundary` : null);
    } else {
      setValidationWarning(null);
    }
  }, [points, isPointInRegion]);

  // Render SA polygon + draw markers
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isMapLoaded) return;
    const saSrc = map.getSource(SA_SRC) as mapboxgl.GeoJSONSource | undefined;
    const ptsSrc = map.getSource(PTS_SRC) as mapboxgl.GeoJSONSource | undefined;

    const polyFeature = latLngToGeoJSON(points);
    saSrc?.setData(polyFeature
      ? { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: polyFeature as GeoJSON.Polygon }] }
      : { type: 'FeatureCollection', features: [] });

    ptsSrc?.setData(isDrawing
      ? {
          type: 'FeatureCollection',
          features: points.map((p, i) => ({
            type: 'Feature',
            properties: { index: i + 1, inside: isPointInRegion(p) },
            geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
          })),
        }
      : { type: 'FeatureCollection', features: [] });
  }, [points, isMapLoaded, isDrawing, isPointInRegion]);

  // Notify parent
  const onBoundaryChangeRef = useRef(onBoundaryChange);
  onBoundaryChangeRef.current = onBoundaryChange;
  useEffect(() => {
    if (points.length >= 3 && !isDrawing) {
      internalUpdateRef.current = true;
      onBoundaryChangeRef.current(latLngToGeoJSON(points));
    }
  }, [points, isDrawing]);

  const calculateArea = (): string => {
    if (points.length < 3) return '0';
    const ring = points.map((p) => [p.lng, p.lat]);
    ring.push(ring[0]);
    const area = turf.area(turf.polygon([ring]));
    return area > 1_000_000 ? `${(area / 1_000_000).toFixed(2)} km²` : `${Math.round(area).toLocaleString()} m²`;
  };

  const handleUndo = () => points.length > 0 && setPoints((p) => p.slice(0, -1));
  const handleClear = () => {
    setPoints([]);
    setIsDrawing(true);
    setValidationWarning(null);
    boundaryInitializedRef.current = false;
    onBoundaryChange(null);
  };
  const handleFinishDrawing = () => {
    if (points.length >= 3) {
      setIsDrawing(false);
      onBoundaryChange(latLngToGeoJSON(points));
    }
  };
  const handleStartRedraw = () => {
    setIsDrawing(true);
    setPoints([]);
  };

  return (
    <div className="space-y-3">
      {region && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Badge variant="outline" className="gap-1">
            <MapPin className="h-3 w-3" /> Region: {region.name}
          </Badge>
          {regionBoundary.length === 0 && (
            <Badge variant="destructive" className="gap-1">
              <AlertTriangle className="h-3 w-3" /> No region boundary defined
            </Badge>
          )}
        </div>
      )}

      <div ref={containerRef} style={{ height, width: '100%' }} className="rounded-lg border border-border overflow-hidden relative">
        {mapInitError && (
          <div className="absolute inset-0 flex items-center justify-center p-4 text-center text-sm text-muted-foreground bg-muted">
            Map unavailable: {mapInitError}. Set VITE_MAPBOX_WEB_TOKEN in Lovable or MAPBOX_WEB_TOKEN on Supabase.
          </div>
        )}
      </div>

      {validationWarning && (
        <div className="flex items-center gap-2 text-amber-600 bg-amber-50 dark:bg-amber-950/20 px-3 py-2 rounded-md text-sm">
          <AlertTriangle className="h-4 w-4 flex-shrink-0" />
          {validationWarning}
        </div>
      )}

      {isEditable && (
        <div className="flex items-center justify-between gap-2 p-3 bg-muted/50 rounded-lg">
          <div className="text-sm text-muted-foreground">
            {isDrawing ? (
              points.length < 3 ? (
                <span className="flex items-center gap-1">
                  <MapPin className="h-4 w-4 text-primary" /> Click on the map to add points ({points.length}/3 minimum)
                </span>
              ) : (
                <span className="flex items-center gap-1 text-green-600">
                  <Check className="h-4 w-4" /> {points.length} points added - Ready to finish
                </span>
              )
            ) : (
              <span className="flex items-center gap-2 text-green-600">
                <Check className="h-4 w-4" /> Boundary set ({points.length} points)
                <Badge variant="secondary" className="gap-1 ml-2">
                  <Ruler className="h-3 w-3" /> {calculateArea()}
                </Badge>
              </span>
            )}
          </div>
          <div className="flex gap-2">
            {isDrawing ? (
              <>
                <Button type="button" variant="outline" size="sm" onClick={handleUndo} disabled={points.length === 0}>
                  <Undo className="h-4 w-4 mr-1" /> Undo
                </Button>
                <Button
                  type="button" size="sm" onClick={handleFinishDrawing}
                  disabled={points.length < 3}
                  className="bg-green-600 hover:bg-green-700"
                >
                  Finish Drawing
                </Button>
              </>
            ) : (
              <>
                <Button type="button" variant="outline" size="sm" onClick={handleStartRedraw}>
                  Redraw
                </Button>
                <Button type="button" variant="destructive" size="sm" onClick={handleClear}>
                  <Trash2 className="h-4 w-4 mr-1" /> Clear
                </Button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
