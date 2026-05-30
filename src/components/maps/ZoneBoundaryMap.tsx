import { useEffect, useRef, useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Trash2, Undo, MapPin, Circle, Hexagon, Target, Check, AlertTriangle, Ruler } from 'lucide-react';
import * as turf from '@turf/turf';
import { mapboxgl, MAPBOX_STYLE } from '@/lib/mapbox';

interface LatLng { lat: number; lng: number }
interface GeoJSONPoly { type: string; coordinates: number[][][] }
interface RegionBoundary {
  id: string;
  name: string;
  geo_boundary: GeoJSONPoly | null;
}
interface ZoneBoundaryMapProps {
  shapeType: 'polygon' | 'circle';
  existingPolygon: GeoJSONPoly | null;
  existingCircle: { center_lat: number | null; center_lng: number | null; radius_meters: number | null };
  region: RegionBoundary | null;
  color: string;
  onPolygonChange: (boundary: GeoJSONPoly | null) => void;
  onCircleChange: (center_lat: number | null, center_lng: number | null, radius_meters: number | null) => void;
  onShapeTypeChange: (type: 'polygon' | 'circle') => void;
  height?: string;
}

const REGION_SRC = 'zone-region-src', REGION_FILL = 'zone-region-fill', REGION_LINE = 'zone-region-line';
const ZONE_SRC = 'zone-src', ZONE_FILL = 'zone-fill', ZONE_LINE = 'zone-line';
const PTS_SRC = 'zone-pts-src', PTS_LAYER = 'zone-pts', PTS_LABELS = 'zone-pts-labels';

function polyToFeature(points: LatLng[]): GeoJSON.Feature<GeoJSON.Polygon> | null {
  if (points.length < 3) return null;
  const ring = points.map((p) => [p.lng, p.lat]);
  ring.push(ring[0]);
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } };
}

function circleToFeature(center: LatLng, radiusM: number): GeoJSON.Feature<GeoJSON.Polygon> {
  return turf.circle([center.lng, center.lat], radiusM / 1000, { steps: 64, units: 'kilometers' });
}

export function ZoneBoundaryMap({
  shapeType,
  existingPolygon,
  existingCircle,
  region,
  color,
  onPolygonChange,
  onCircleChange,
  onShapeTypeChange,
  height = '400px',
}: ZoneBoundaryMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const centerMarkerRef = useRef<mapboxgl.Marker | null>(null);
  const initializedRef = useRef(false);
  const prevDataRef = useRef<string>('');

  const [isMapLoaded, setIsMapLoaded] = useState(false);
  const [points, setPoints] = useState<LatLng[]>([]);
  const [isDrawing, setIsDrawing] = useState(true);
  const [circleCenter, setCircleCenter] = useState<LatLng | null>(null);
  const [circleRadius, setCircleRadius] = useState<number>(500);
  const [validationWarning, setValidationWarning] = useState<string | null>(null);

  const isDrawingRef = useRef(isDrawing);
  const shapeTypeRef = useRef(shapeType);
  useEffect(() => { isDrawingRef.current = isDrawing; shapeTypeRef.current = shapeType; }, [isDrawing, shapeType]);

  // Init from existing data
  useEffect(() => {
    const key = JSON.stringify({
      shapeType,
      polygon: existingPolygon?.coordinates?.[0] ? 'has' : 'none',
      circleLat: existingCircle.center_lat,
      circleLng: existingCircle.center_lng,
      circleR: existingCircle.radius_meters,
    });
    if (key === prevDataRef.current) return;
    prevDataRef.current = key;

    if (shapeType === 'polygon' && existingPolygon?.coordinates?.[0]) {
      const coords = existingPolygon.coordinates[0];
      setPoints(coords.slice(0, -1).map((c) => ({ lat: c[1], lng: c[0] })));
      setIsDrawing(false);
    } else if (shapeType === 'circle' && existingCircle.center_lat && existingCircle.center_lng) {
      setCircleCenter({ lat: existingCircle.center_lat, lng: existingCircle.center_lng });
      setCircleRadius(existingCircle.radius_meters || 500);
      setIsDrawing(false);
    } else if (!initializedRef.current) {
      setPoints([]); setCircleCenter(null); setIsDrawing(true);
    }
    initializedRef.current = true;
  }, [shapeType, existingPolygon, existingCircle]);

  const getMapCenter = useCallback((): [number, number] => {
    if (region?.geo_boundary?.coordinates?.[0]) {
      const coords = region.geo_boundary.coordinates[0];
      const lat = coords.reduce((s, c) => s + c[1], 0) / coords.length;
      const lng = coords.reduce((s, c) => s + c[0], 0) / coords.length;
      return [lng, lat];
    }
    return [-0.1278, 51.5074];
  }, [region]);

  // Init map
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: MAPBOX_STYLE,
      center: getMapCenter(),
      zoom: 12,
    });
    map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'top-left');
    map.addControl(new mapboxgl.FullscreenControl(), 'top-right');

    map.on('load', () => {
      map.addSource(REGION_SRC, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({ id: REGION_FILL, type: 'fill', source: REGION_SRC, paint: { 'fill-color': '#6B7280', 'fill-opacity': 0.05 } });
      map.addLayer({ id: REGION_LINE, type: 'line', source: REGION_SRC, paint: { 'line-color': '#6B7280', 'line-width': 2, 'line-dasharray': [4, 2] } });

      map.addSource(ZONE_SRC, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({ id: ZONE_FILL, type: 'fill', source: ZONE_SRC, paint: { 'fill-color': color, 'fill-opacity': 0.25 } });
      map.addLayer({ id: ZONE_LINE, type: 'line', source: ZONE_SRC, paint: { 'line-color': color, 'line-width': 2 } });

      map.addSource(PTS_SRC, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({
        id: PTS_LAYER, type: 'circle', source: PTS_SRC,
        paint: { 'circle-radius': 9, 'circle-color': color, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 },
      });
      map.addLayer({
        id: PTS_LABELS, type: 'symbol', source: PTS_SRC,
        layout: { 'text-field': ['get', 'index'], 'text-size': 11, 'text-allow-overlap': true },
        paint: { 'text-color': '#ffffff' },
      });

      setIsMapLoaded(true);
    });

    map.on('click', (e) => {
      if (!isDrawingRef.current) return;
      const pt = { lat: e.lngLat.lat, lng: e.lngLat.lng };
      if (shapeTypeRef.current === 'polygon') setPoints((prev) => [...prev, pt]);
      else { setCircleCenter(pt); setIsDrawing(false); }
    });

    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Update fill color when color changes
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isMapLoaded) return;
    map.setPaintProperty(ZONE_FILL, 'fill-color', color);
    map.setPaintProperty(ZONE_LINE, 'line-color', color);
    map.setPaintProperty(PTS_LAYER, 'circle-color', color);
  }, [color, isMapLoaded]);

  // Render region
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isMapLoaded) return;
    const src = map.getSource(REGION_SRC) as mapboxgl.GeoJSONSource | undefined;
    if (region?.geo_boundary?.coordinates?.[0]) {
      src?.setData({
        type: 'FeatureCollection',
        features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: region.geo_boundary.coordinates } as GeoJSON.Polygon }],
      });
      const bounds = new mapboxgl.LngLatBounds();
      region.geo_boundary.coordinates[0].forEach((c) => bounds.extend([c[0], c[1]]));
      map.fitBounds(bounds, { padding: 50, animate: false });
    } else {
      src?.setData({ type: 'FeatureCollection', features: [] });
    }
  }, [region, isMapLoaded]);

  const isPointInRegion = useCallback((point: LatLng): boolean => {
    if (!region?.geo_boundary?.coordinates?.[0]) return true;
    return turf.booleanPointInPolygon(
      turf.point([point.lng, point.lat]),
      turf.polygon(region.geo_boundary.coordinates as number[][][])
    );
  }, [region]);

  // Validation
  useEffect(() => {
    if (shapeType === 'polygon' && points.length >= 3) {
      const out = points.filter((p) => !isPointInRegion(p));
      setValidationWarning(out.length > 0 ? `${out.length} point(s) are outside the region boundary` : null);
    } else if (shapeType === 'circle' && circleCenter) {
      setValidationWarning(!isPointInRegion(circleCenter) ? 'Circle center is outside the region boundary' : null);
    } else {
      setValidationWarning(null);
    }
  }, [points, circleCenter, shapeType, isPointInRegion]);

  // Render zone shape
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isMapLoaded) return;
    const zoneSrc = map.getSource(ZONE_SRC) as mapboxgl.GeoJSONSource | undefined;
    const ptsSrc = map.getSource(PTS_SRC) as mapboxgl.GeoJSONSource | undefined;

    if (shapeType === 'polygon') {
      const feat = polyToFeature(points);
      zoneSrc?.setData(feat ? { type: 'FeatureCollection', features: [feat] } : { type: 'FeatureCollection', features: [] });
      ptsSrc?.setData(isDrawing
        ? {
            type: 'FeatureCollection',
            features: points.map((p, i) => ({
              type: 'Feature',
              properties: { index: i + 1 },
              geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
            })),
          }
        : { type: 'FeatureCollection', features: [] });
      // Remove center marker if present
      centerMarkerRef.current?.remove();
      centerMarkerRef.current = null;
    } else {
      if (circleCenter) {
        const feat = circleToFeature(circleCenter, circleRadius);
        zoneSrc?.setData({ type: 'FeatureCollection', features: [feat] });
        ptsSrc?.setData({ type: 'FeatureCollection', features: [] });

        // Draggable center marker
        if (!centerMarkerRef.current) {
          const el = document.createElement('div');
          el.style.width = '16px'; el.style.height = '16px'; el.style.borderRadius = '50%';
          el.style.background = color; el.style.border = '2px solid #ffffff';
          el.style.boxShadow = '0 1px 4px rgba(0,0,0,0.4)';
          centerMarkerRef.current = new mapboxgl.Marker({ element: el, draggable: true })
            .setLngLat([circleCenter.lng, circleCenter.lat])
            .addTo(map);
          centerMarkerRef.current.on('dragend', () => {
            const ll = centerMarkerRef.current!.getLngLat();
            setCircleCenter({ lat: ll.lat, lng: ll.lng });
          });
        } else {
          centerMarkerRef.current.setLngLat([circleCenter.lng, circleCenter.lat]);
        }
      } else {
        zoneSrc?.setData({ type: 'FeatureCollection', features: [] });
        ptsSrc?.setData({ type: 'FeatureCollection', features: [] });
        centerMarkerRef.current?.remove();
        centerMarkerRef.current = null;
      }
    }
  }, [points, circleCenter, circleRadius, isMapLoaded, isDrawing, shapeType, color]);

  // Notify parent
  useEffect(() => {
    if (shapeType === 'polygon' && points.length >= 3 && !isDrawing) {
      const ring = points.map((p) => [p.lng, p.lat]);
      ring.push(ring[0]);
      onPolygonChange({ type: 'Polygon', coordinates: [ring] });
    } else if (shapeType === 'polygon') {
      onPolygonChange(null);
    }
  }, [points, isDrawing, shapeType, onPolygonChange]);

  useEffect(() => {
    if (shapeType === 'circle' && circleCenter && !isDrawing) {
      onCircleChange(circleCenter.lat, circleCenter.lng, circleRadius);
    } else if (shapeType === 'circle') {
      onCircleChange(null, null, null);
    }
  }, [circleCenter, circleRadius, isDrawing, shapeType, onCircleChange]);

  const handleUndo = () => shapeType === 'polygon' && points.length > 0 && setPoints((p) => p.slice(0, -1));
  const handleClear = () => {
    setPoints([]); setCircleCenter(null); setCircleRadius(500);
    setIsDrawing(true); setValidationWarning(null);
    onPolygonChange(null); onCircleChange(null, null, null);
  };
  const handleFinishDrawing = () => { if (shapeType === 'polygon' && points.length >= 3) setIsDrawing(false); };
  const handleStartRedraw = () => { setIsDrawing(true); setPoints([]); };

  const calculatePolygonArea = (): string => {
    if (points.length < 3) return '0';
    const ring = points.map((p) => [p.lng, p.lat]); ring.push(ring[0]);
    const area = turf.area(turf.polygon([ring]));
    return area > 1_000_000 ? `${(area / 1_000_000).toFixed(2)} km²` : `${Math.round(area).toLocaleString()} m²`;
  };
  const calculateCircleArea = (): string => {
    const area = Math.PI * Math.pow(circleRadius, 2);
    return area > 1_000_000 ? `${(area / 1_000_000).toFixed(2)} km²` : `${Math.round(area).toLocaleString()} m²`;
  };

  const hasValidShape = shapeType === 'polygon' ? points.length >= 3 && !isDrawing : circleCenter !== null && !isDrawing;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Label className="text-sm font-medium">Shape Type:</Label>
        <div className="flex gap-2">
          <Button type="button" variant={shapeType === 'polygon' ? 'default' : 'outline'} size="sm"
            onClick={() => { handleClear(); onShapeTypeChange('polygon'); }} className="gap-2">
            <Hexagon className="h-4 w-4" /> Polygon
          </Button>
          <Button type="button" variant={shapeType === 'circle' ? 'default' : 'outline'} size="sm"
            onClick={() => { handleClear(); onShapeTypeChange('circle'); }} className="gap-2">
            <Circle className="h-4 w-4" /> Circle
          </Button>
        </div>
      </div>

      <div ref={containerRef} style={{ height, width: '100%' }} className="rounded-lg border border-border overflow-hidden" />

      {validationWarning && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-700">
          <AlertTriangle className="h-4 w-4 flex-shrink-0" />
          <span className="text-sm">{validationWarning}</span>
        </div>
      )}

      <div className="flex flex-col gap-3 p-4 bg-muted/50 rounded-lg">
        <div className="text-sm text-muted-foreground">
          {shapeType === 'polygon' ? (
            isDrawing ? (
              points.length < 3 ? (
                <span className="flex items-center gap-2">
                  <MapPin className="h-4 w-4 text-primary" />
                  Click on the map to add points ({points.length}/3 minimum required)
                </span>
              ) : (
                <span className="flex items-center gap-2 text-green-600">
                  <Check className="h-4 w-4" /> {points.length} points added - Click "Finish Drawing" to complete
                </span>
              )
            ) : (
              <span className="flex items-center gap-2 text-primary">
                <Check className="h-4 w-4" /> Polygon set ({points.length} points)
              </span>
            )
          ) : (
            isDrawing ? (
              <span className="flex items-center gap-2">
                <Target className="h-4 w-4 text-primary" /> Click on the map to place the circle center
              </span>
            ) : (
              <span className="flex items-center gap-2 text-primary">
                <Check className="h-4 w-4" /> Circle placed - Drag center marker or adjust radius
              </span>
            )
          )}
        </div>

        {shapeType === 'circle' && circleCenter && (
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <Ruler className="h-4 w-4 text-muted-foreground" />
              <Label className="text-sm">Radius (meters):</Label>
              <Input
                type="number"
                value={circleRadius}
                onChange={(e) => {
                  const v = parseInt(e.target.value) || 100;
                  setCircleRadius(Math.max(50, Math.min(50000, v)));
                }}
                className="w-24 h-8" min={50} max={50000}
              />
            </div>
            <Badge variant="outline" className="gap-1">Area: {calculateCircleArea()}</Badge>
          </div>
        )}

        {shapeType === 'polygon' && points.length >= 3 && (
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="gap-1">
              <Ruler className="h-3 w-3" /> Area: {calculatePolygonArea()}
            </Badge>
            <Badge variant="outline">{points.length} vertices</Badge>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex gap-2">
            {shapeType === 'polygon' && isDrawing && (
              <Button type="button" variant="outline" size="sm" onClick={handleUndo} disabled={points.length === 0}>
                <Undo className="h-4 w-4 mr-1" /> Undo
              </Button>
            )}
            <Button type="button" variant="outline" size="sm" onClick={handleClear} disabled={points.length === 0 && !circleCenter}>
              <Trash2 className="h-4 w-4 mr-1" /> Clear
            </Button>
          </div>
          <div className="flex gap-2">
            {shapeType === 'polygon' && isDrawing && (
              <Button type="button" size="sm" onClick={handleFinishDrawing} disabled={points.length < 3} className="bg-primary hover:bg-primary/90">
                <Check className="h-4 w-4 mr-1" /> Finish Drawing
              </Button>
            )}
            {shapeType === 'polygon' && !isDrawing && (
              <Button type="button" variant="outline" size="sm" onClick={handleStartRedraw}>Redraw Polygon</Button>
            )}
            {shapeType === 'circle' && !isDrawing && circleCenter && (
              <Button type="button" variant="outline" size="sm" onClick={() => { setCircleCenter(null); setIsDrawing(true); }}>
                Reposition Circle
              </Button>
            )}
          </div>
        </div>

        <div className="flex items-center justify-center gap-2 pt-2 border-t border-border/50">
          {hasValidShape ? (
            <Badge className="bg-green-500/10 text-green-600 border-green-500/30 gap-1">
              <Check className="h-3 w-3" /> Ready to save
            </Badge>
          ) : (
            <Badge variant="secondary" className="gap-1">
              <MapPin className="h-3 w-3" /> {shapeType === 'polygon' ? 'Draw at least 3 points' : 'Click to place circle'}
            </Badge>
          )}
        </div>
      </div>
    </div>
  );
}
