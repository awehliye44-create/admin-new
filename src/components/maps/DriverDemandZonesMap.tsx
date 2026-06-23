import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { mapboxgl } from '@/lib/mapbox';
import { createMapboxMap } from '@/lib/mapboxMap';
import { useMapboxToken } from '@/hooks/useMapboxToken';
import { buildAdminDemandZonesGeoJson, type AdminDemandZone } from '@/lib/demandZoneGeojson';
import { DEMAND_LEGEND_ITEMS } from '@/lib/demandZoneMapStyle';

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

function fitToFeatures(
  map: mapboxgl.Map,
  zones: AdminDemandZone[],
  boundary?: GeoJSON.Polygon | null,
) {
  const bounds = new mapboxgl.LngLatBounds();
  let hasBounds = false;

  for (const zone of zones) {
    bounds.extend([zone.center_lng, zone.center_lat]);
    hasBounds = true;
  }

  if (boundary?.coordinates?.[0]) {
    for (const coord of boundary.coordinates[0]) {
      bounds.extend([coord[0], coord[1]]);
      hasBounds = true;
    }
  }

  if (hasBounds) {
    map.fitBounds(bounds, { padding: 48, maxZoom: 14, duration: 600 });
  }
}

export function DriverDemandZonesMap({
  zones,
  serviceAreaBoundary,
  height = '560px',
  onZoneClick,
}: DriverDemandZonesMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const { isReady: mapboxReady, error: mapboxError } = useMapboxToken();
  const [isMapLoaded, setIsMapLoaded] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);

  useEffect(() => {
    if (!mapboxReady || !containerRef.current || mapRef.current) return;

    const map = createMapboxMap(containerRef.current, {
      center: [-0.77, 52.04],
      zoom: 11,
    });

    map.on('load', () => {
      setIsMapLoaded(true);
      map.addSource(ZONE_SOURCE, {
        type: 'geojson',
        data: buildAdminDemandZonesGeoJson([]),
      });

      map.addLayer({
        id: ZONE_FILL,
        type: 'fill',
        source: ZONE_SOURCE,
        paint: {
          'fill-color': ['get', 'fillColor'],
          'fill-opacity': ['get', 'fillOpacity'],
        },
      });

      map.addLayer({
        id: ZONE_LINE,
        type: 'line',
        source: ZONE_SOURCE,
        paint: {
          'line-color': ['get', 'strokeColor'],
          'line-opacity': ['get', 'strokeOpacity'],
          'line-width': 2,
        },
      });

      map.addSource(BOUNDARY_SOURCE, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });

      map.addLayer({
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

      if (onZoneClick) {
        map.on('click', ZONE_FILL, (e) => {
          const id = e.features?.[0]?.properties?.id;
          if (typeof id === 'string') onZoneClick(id);
        });
        map.on('mouseenter', ZONE_FILL, () => {
          map.getCanvas().style.cursor = 'pointer';
        });
        map.on('mouseleave', ZONE_FILL, () => {
          map.getCanvas().style.cursor = '';
        });
      }
    });

    map.on('error', (e) => {
      setMapError(e.error?.message ?? 'Map failed to load');
    });

    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
      setIsMapLoaded(false);
    };
  }, [mapboxReady, onZoneClick]);

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

    fitToFeatures(map, zones, serviceAreaBoundary);
  }, [zones, serviceAreaBoundary, isMapLoaded]);

  const initError = mapboxError ?? mapError;

  return (
    <div className="relative overflow-hidden rounded-lg border bg-muted/20" style={{ height }}>
      <div ref={containerRef} className="absolute inset-0" />

      {!mapboxReady && !initError && (
        <div className="absolute inset-0 flex items-center justify-center bg-muted/40">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      )}

      {initError && (
        <div className="absolute inset-0 flex items-center justify-center bg-muted/40 p-4 text-center text-sm text-destructive">
          {initError}
        </div>
      )}

      {zones.length === 0 && isMapLoaded && !initError && (
        <div className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 text-center text-sm text-muted-foreground">
          No zones match the current filters.
        </div>
      )}

      <div className="pointer-events-none absolute bottom-3 left-3 rounded-lg border bg-background/95 px-3 py-2 shadow-md backdrop-blur-sm">
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
