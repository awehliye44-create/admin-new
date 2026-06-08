import { useEffect, useRef, useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Trash2, Undo, MapPin } from 'lucide-react';
import { mapboxgl } from '@/lib/mapbox';
import { createMapboxMap } from '@/lib/mapboxMap';
import { useMapboxToken } from '@/hooks/useMapboxToken';

interface LatLng {
  lat: number;
  lng: number;
}

interface RegionBoundaryMapProps {
  boundary: LatLng[] | null;
  onBoundaryChange: (boundary: LatLng[]) => void;
  isEditable?: boolean;
  height?: string;
}

const FILL_SRC = 'region-fill-src';
const FILL_LAYER = 'region-fill-layer';
const LINE_LAYER = 'region-line-layer';
const POINTS_SRC = 'region-points-src';
const POINTS_LAYER = 'region-points-layer';
const POINTS_LABELS = 'region-points-labels';

function buildPolygonFeature(points: LatLng[]): GeoJSON.Feature<GeoJSON.Polygon> | null {
  if (points.length < 3) return null;
  const ring = points.map((p) => [p.lng, p.lat]);
  ring.push(ring[0]);
  return {
    type: 'Feature',
    properties: {},
    geometry: { type: 'Polygon', coordinates: [ring] },
  };
}

function buildPointsFC(points: LatLng[]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: points.map((p, i) => ({
      type: 'Feature',
      properties: { index: i + 1 },
      geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
    })),
  };
}

export function RegionBoundaryMap({
  boundary,
  onBoundaryChange,
  isEditable = true,
  height = '400px',
}: RegionBoundaryMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const { isReady: mapboxReady, error: mapboxError } = useMapboxToken();
  const [isMapLoaded, setIsMapLoaded] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);
  const mapInitError = mapboxError ?? mapError;
  const [points, setPoints] = useState<LatLng[]>(boundary || []);
  const [isDrawing, setIsDrawing] = useState(!boundary || boundary.length === 0);

  const isDrawingRef = useRef(isDrawing);
  useEffect(() => {
    isDrawingRef.current = isDrawing;
  }, [isDrawing]);

  // Init map after web token resolves
  useEffect(() => {
    if (!mapboxReady || !containerRef.current || mapRef.current) return;

    let cancelled = false;
    let detachResize: (() => void) | undefined;

    const defaultCenter: [number, number] = [-0.7594, 52.0406];
    const center: [number, number] = boundary && boundary.length > 0
      ? [boundary[0].lng, boundary[0].lat]
      : defaultCenter;

    void (async () => {
      try {
        const { map, detachResize: detach } = await createMapboxMap({
          container: containerRef.current!,
          center,
          zoom: 11,
          onLoad: (m) => {
            if (cancelled) return;
            m.addSource(FILL_SRC, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
            m.addLayer({ id: FILL_LAYER, type: 'fill', source: FILL_SRC, paint: { 'fill-color': '#3b82f6', 'fill-opacity': 0.2 } });
            m.addLayer({ id: LINE_LAYER, type: 'line', source: FILL_SRC, paint: { 'line-color': '#3b82f6', 'line-width': 2 } });
            m.addSource(POINTS_SRC, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
            m.addLayer({
              id: POINTS_LAYER,
              type: 'circle',
              source: POINTS_SRC,
              paint: { 'circle-radius': 8, 'circle-color': '#3b82f6', 'circle-stroke-color': '#1d4ed8', 'circle-stroke-width': 2 },
            });
            m.addLayer({
              id: POINTS_LABELS,
              type: 'symbol',
              source: POINTS_SRC,
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

  // Sync source data when points change
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isMapLoaded) return;
    const fillSrc = map.getSource(FILL_SRC) as mapboxgl.GeoJSONSource | undefined;
    const ptsSrc = map.getSource(POINTS_SRC) as mapboxgl.GeoJSONSource | undefined;

    const polygon = buildPolygonFeature(points);
    fillSrc?.setData(polygon ? { type: 'FeatureCollection', features: [polygon] } : { type: 'FeatureCollection', features: [] });
    ptsSrc?.setData(isDrawing ? buildPointsFC(points) : { type: 'FeatureCollection', features: [] });
  }, [points, isMapLoaded, isDrawing]);

  const handleUndo = () => points.length > 0 && setPoints((p) => p.slice(0, -1));
  const handleClear = () => {
    setPoints([]);
    setIsDrawing(true);
    onBoundaryChange([]);
  };
  const handleFinishDrawing = () => {
    if (points.length >= 5) {
      setIsDrawing(false);
      onBoundaryChange(points);
    }
  };
  const handleEditMode = () => setIsDrawing(true);

  return (
    <div className="space-y-3">
      <div ref={containerRef} style={{ height, width: '100%' }} className="rounded-lg border border-border overflow-hidden relative">
        {mapInitError && (
          <div className="absolute inset-0 flex items-center justify-center p-4 text-center text-sm text-muted-foreground bg-muted">
            Map unavailable: {mapInitError}. Set VITE_MAPBOX_WEB_TOKEN in Lovable or MAPBOX_WEB_TOKEN on Supabase.
          </div>
        )}
      </div>
      {isEditable && (
        <div className="flex items-center justify-between gap-2 p-3 bg-muted/50 rounded-lg">
          <div className="text-sm text-muted-foreground">
            {isDrawing ? (
              points.length < 5 ? (
                <span className="flex items-center gap-1">
                  <MapPin className="h-4 w-4 text-primary" />
                  Click on the map to add points ({points.length}/5 minimum)
                </span>
              ) : (
                <span className="flex items-center gap-1 text-green-600">
                  ✓ {points.length} points added - Ready to finish
                </span>
              )
            ) : (
              <span className="flex items-center gap-1 text-blue-600">
                ✓ Boundary set ({points.length} points)
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
                  type="button"
                  size="sm"
                  onClick={handleFinishDrawing}
                  disabled={points.length < 5}
                  className="bg-primary hover:bg-primary/90"
                >
                  Finish Drawing
                </Button>
              </>
            ) : (
              <>
                <Button type="button" variant="outline" size="sm" onClick={handleEditMode}>
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
