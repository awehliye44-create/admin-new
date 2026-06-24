import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { mapboxgl } from '@/lib/mapbox';
import { createMapboxMap } from '@/lib/mapboxMap';
import { useMapboxToken } from '@/hooks/useMapboxToken';
import { buildAdminDemandZonesGeoJson, type AdminDemandZone } from '@/lib/demandZoneGeojson';
import { DEMAND_LEGEND_ITEMS } from '@/lib/demandZoneMapStyle';
import { attachAdminMapControls } from '@/lib/mapControls';
import {
  buildDemandZonesBounds,
  DEFAULT_MAP_CENTER,
  DEFAULT_MAP_ZOOM,
  fitMapToLngLatBounds,
  recenterMap,
} from '@/lib/mapBounds';

const ZONE_SOURCE = 'admin-demand-zones-src';
const ZONE_FILL = 'admin-demand-zones-fill';
const ZONE_LINE = 'admin-demand-zones-line';
const BOUNDARY_SOURCE = 'admin-service-area-boundary-src';
const BOUNDARY_LINE = 'admin-service-area-boundary-line';

interface DriverDemandZonesMapProps {
  zones: AdminDemandZone[];
  serviceAreaBoundary?: GeoJSON.Polygon | null;
  height?: string;
  onZoneClick?: (zoneId: string) => void;
}

export function DriverDemandZonesMap({
  zones,
  serviceAreaBoundary,
  height = '560px',
  onZoneClick,
}: DriverDemandZonesMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const onZoneClickRef = useRef(onZoneClick);
  const detachControlsRef = useRef<(() => void) | null>(null);
  const zonesRef = useRef(zones);
  const boundaryRef = useRef(serviceAreaBoundary);
  const { isReady: mapboxReady, error: mapboxError } = useMapboxToken();
  const [isMapLoaded, setIsMapLoaded] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);

  useEffect(() => {
    onZoneClickRef.current = onZoneClick;
  }, [onZoneClick]);

  useEffect(() => {
    zonesRef.current = zones;
    boundaryRef.current = serviceAreaBoundary;
  }, [zones, serviceAreaBoundary]);

  const fitToCurrentView = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    const bounds = buildDemandZonesBounds(zonesRef.current, boundaryRef.current);
    if (bounds) {
      fitMapToLngLatBounds(map, bounds, { maxZoom: 14 });
      return;
    }
    recenterMap(map, DEFAULT_MAP_CENTER, DEFAULT_MAP_ZOOM);
  }, []);

  const recenterDefault = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    recenterMap(map, DEFAULT_MAP_CENTER, DEFAULT_MAP_ZOOM);
  }, []);

  useEffect(() => {
    if (!mapboxReady || !containerRef.current || mapRef.current) return;

    let cancelled = false;
    let detachResize: (() => void) | undefined;

    void (async () => {
      try {
        const { map, detachResize: detach } = await createMapboxMap({
          container: containerRef.current!,
          center: DEFAULT_MAP_CENTER,
          zoom: DEFAULT_MAP_ZOOM,
          onLoad: (m) => {
            if (cancelled) return;
            m.addSource(ZONE_SOURCE, {
              type: 'geojson',
              data: buildAdminDemandZonesGeoJson([]),
            });

            m.addLayer({
              id: ZONE_FILL,
              type: 'fill',
              source: ZONE_SOURCE,
              paint: {
                'fill-color': ['get', 'fillColor'],
                'fill-opacity': ['get', 'fillOpacity'],
              },
            });

            m.addLayer({
              id: ZONE_LINE,
              type: 'line',
              source: ZONE_SOURCE,
              paint: {
                'line-color': ['get', 'strokeColor'],
                'line-opacity': ['get', 'strokeOpacity'],
                'line-width': 2,
              },
            });

            m.addSource(BOUNDARY_SOURCE, {
              type: 'geojson',
              data: { type: 'FeatureCollection', features: [] },
            });

            m.addLayer({
              id: BOUNDARY_LINE,
              type: 'line',
              source: BOUNDARY_SOURCE,
              paint: {
                'line-color': '#64748b',
                'line-opacity': 0.85,
                'line-width': 2,
                'line-dasharray': [4, 3],
              },
            });

            m.on('click', ZONE_FILL, (e) => {
              const id = e.features?.[0]?.properties?.id;
              if (typeof id === 'string') onZoneClickRef.current?.(id);
            });
            m.on('mouseenter', ZONE_FILL, () => {
              m.getCanvas().style.cursor = 'pointer';
            });
            m.on('mouseleave', ZONE_FILL, () => {
              m.getCanvas().style.cursor = '';
            });

            setIsMapLoaded(true);
          },
          onIdle: (m) => {
            m.resize();
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

        detachControlsRef.current = attachAdminMapControls(map, {
          onFit: () => fitToCurrentView(),
          onRecenter: () => recenterDefault(),
          fitTitle: 'Fit to zones',
          recenterTitle: 'Recenter on Milton Keynes',
        });

        detachResize = detach;
        mapRef.current = map;
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : 'Failed to initialize map';
        setMapError(msg);
      }
    })();

    return () => {
      cancelled = true;
      detachControlsRef.current?.();
      detachControlsRef.current = null;
      detachResize?.();
      mapRef.current?.remove();
      mapRef.current = null;
      setIsMapLoaded(false);
    };
  }, [mapboxReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isMapLoaded) return;

    const source = map.getSource(ZONE_SOURCE) as mapboxgl.GeoJSONSource | undefined;
    source?.setData(buildAdminDemandZonesGeoJson(zones));

    const boundarySource = map.getSource(BOUNDARY_SOURCE) as mapboxgl.GeoJSONSource | undefined;
    if (boundarySource) {
      if (serviceAreaBoundary) {
        boundarySource.setData({
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              properties: {},
              geometry: serviceAreaBoundary,
            },
          ],
        });
      } else {
        boundarySource.setData({ type: 'FeatureCollection', features: [] });
      }
    }

    fitToCurrentView();
  }, [zones, serviceAreaBoundary, isMapLoaded, fitToCurrentView]);

  const initError = mapboxError ?? mapError;

  return (
    <div
      className="relative min-h-[400px] w-full overflow-hidden rounded-lg border bg-muted/20"
      style={{ height }}
    >
      <div ref={containerRef} className="absolute inset-0 min-h-[400px] w-full" />

      {!mapboxReady && !initError && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-muted/40">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      )}

      {initError && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-muted/40 p-4 text-center text-sm text-destructive">
          {initError}
        </div>
      )}

      {zones.length === 0 && isMapLoaded && !initError && (
        <div className="pointer-events-none absolute inset-x-0 top-1/2 z-[1] -translate-y-1/2 text-center text-sm text-muted-foreground">
          No zones match the current filters.
        </div>
      )}

      <div className="pointer-events-none absolute bottom-3 left-3 z-[1] rounded-lg border bg-background/95 px-3 py-2 shadow-md backdrop-blur-sm">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
          Demand levels
        </p>
        <ul className="space-y-1">
          {DEMAND_LEGEND_ITEMS.map(({ level, label, fill, stroke }) => (
            <li key={level} className="flex items-center gap-2 text-xs text-foreground">
              <span
                className="h-3 w-3 rounded-full border shrink-0"
                style={{ backgroundColor: fill, borderColor: stroke }}
                aria-hidden
              />
              <span>{label}</span>
            </li>
          ))}
        </ul>
        {serviceAreaBoundary && (
          <p className="mt-2 flex items-center gap-2 text-[10px] text-muted-foreground">
            <span className="inline-block h-0 w-4 border-t-2 border-dashed border-slate-500" />
            Service area boundary
          </p>
        )}
      </div>
    </div>
  );
}
