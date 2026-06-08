import { mapboxgl, MAPBOX_STYLE, resolveMapboxToken } from '@/lib/mapbox';

export interface CreateMapboxMapOptions {
  container: HTMLElement;
  style?: string;
  center?: [number, number];
  zoom?: number;
  onLoad?: (map: mapboxgl.Map) => void;
  onTileError?: (message: string) => void;
}

/**
 * Ensures mapboxgl.accessToken is set from the web token, then creates a Map.
 * Callers must remove the map and detach resize listeners in useEffect cleanup.
 */
export async function createMapboxMap(options: CreateMapboxMapOptions): Promise<{
  map: mapboxgl.Map;
  detachResize: () => void;
}> {
  const token = await resolveMapboxToken();
  if (!token?.startsWith('pk.')) {
    throw new Error(
      'Mapbox web token missing. Set VITE_MAPBOX_WEB_TOKEN in .env.local (restart dev server) or MAPBOX_WEB_TOKEN on Supabase for hosted builds.',
    );
  }

  mapboxgl.accessToken = token;

  const map = new mapboxgl.Map({
    container: options.container,
    style: options.style ?? MAPBOX_STYLE,
    center: options.center ?? [-0.7594, 52.0406],
    zoom: options.zoom ?? 13,
  });

  const onWindowResize = () => {
    try {
      map.resize();
    } catch {
      /* map may be removed */
    }
  };

  map.on('load', () => {
    map.resize();
    options.onLoad?.(map);
    // Detect silent vector-tile 403 (gray map + logo) when GL does not emit error.message
    const probeToken = mapboxgl.accessToken || '';
    if (probeToken.startsWith('pk.')) {
      void fetch(
        `https://api.mapbox.com/v4/mapbox.mapbox-streets-v8/0/0/0.vector.pbf?access_token=${encodeURIComponent(probeToken)}`,
      )
        .then((res) => {
          if (res.status === 403) {
            options.onTileError?.(
              'Mapbox tile access denied (403). Use a URL-restricted web token (VITE_MAPBOX_WEB_TOKEN), not the native app token.',
            );
          }
        })
        .catch(() => undefined);
    }
  });

  map.on('error', (e) => {
    const msg = e.error?.message;
    if (!msg) {
      // Source-only events (e.g. composite) are often non-fatal; ignore without an Error message.
      return;
    }
    const lower = msg.toLowerCase();
    const isAuthOrTileFailure =
      lower.includes('403') ||
      lower.includes('401') ||
      lower.includes('unauthorized') ||
      lower.includes('forbidden') ||
      lower.includes('token') ||
      lower.includes('not authorized') ||
      lower.includes('load failed');
    if (isAuthOrTileFailure) {
      console.error('[mapbox] tile/style error:', msg);
      const userMsg = lower.includes('403') || lower.includes('forbidden')
        ? 'Mapbox tile access denied (403). Use a URL-restricted web token (VITE_MAPBOX_WEB_TOKEN), not the native app token.'
        : msg;
      options.onTileError?.(userMsg);
    } else {
      console.warn('[mapbox] map warning:', msg);
    }
  });

  window.addEventListener('resize', onWindowResize);

  return {
    map,
    detachResize: () => window.removeEventListener('resize', onWindowResize),
  };
}
