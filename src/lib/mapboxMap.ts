import { mapboxgl, MAPBOX_STYLE, resolveMapboxToken } from '@/lib/mapbox';

const TILE_403_MESSAGE =
  'Mapbox tile access denied (403). Add VITE_MAPBOX_WEB_TOKEN in Lovable (or MAPBOX_WEB_TOKEN on Supabase) and allow this admin URL in the Mapbox token URL restrictions.';

const DEFAULT_LOAD_TIMEOUT_MS = 15_000;

export interface CreateMapboxMapOptions {
  container: HTMLElement;
  style?: string;
  center?: [number, number];
  zoom?: number;
  loadTimeoutMs?: number;
  onLoad?: (map: mapboxgl.Map) => void;
  onIdle?: (map: mapboxgl.Map) => void;
  onTileError?: (message: string) => void;
  onLoadTimeout?: () => void;
}

/** Probe style + vector tile access before/at map init (403 often has no GL error.message). */
export async function probeMapboxTileAccess(token: string): Promise<string | null> {
  if (!token.startsWith('pk.')) {
    return 'Mapbox web token missing or invalid (expected pk.*).';
  }

  const styleUrl = `https://api.mapbox.com/styles/v1/mapbox/streets-v12?access_token=${encodeURIComponent(token)}`;
  const tileUrl = `https://api.mapbox.com/v4/mapbox.mapbox-streets-v8/0/0/0.vector.pbf?access_token=${encodeURIComponent(token)}`;

  try {
    const [styleRes, tileRes] = await Promise.all([
      fetch(styleUrl),
      fetch(tileUrl),
    ]);
    if (styleRes.status === 403 || tileRes.status === 403) {
      return TILE_403_MESSAGE;
    }
    if (!styleRes.ok) {
      return `Mapbox style request failed (HTTP ${styleRes.status}). Check VITE_MAPBOX_WEB_TOKEN and URL restrictions on adminonecab.net.`;
    }
    if (!tileRes.ok) {
      return `Mapbox tile request failed (HTTP ${tileRes.status}). Check VITE_MAPBOX_WEB_TOKEN and URL restrictions on adminonecab.net.`;
    }
  } catch {
    /* Network flake — let GL try; timeout/error handlers will surface persistent failures. */
  }

  return null;
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

  const probeError = await probeMapboxTileAccess(token);
  if (probeError) {
    options.onTileError?.(probeError);
  }

  mapboxgl.accessToken = token;

  const map = new mapboxgl.Map({
    container: options.container,
    style: options.style ?? MAPBOX_STYLE,
    center: options.center ?? [-0.7594, 52.0406],
    zoom: options.zoom ?? 13,
  });

  let loadSettled = false;
  const settleLoad = () => {
    if (loadSettled) return;
    loadSettled = true;
    window.clearTimeout(loadTimeoutId);
  };

  const loadTimeoutId = window.setTimeout(() => {
    if (loadSettled) return;
    loadSettled = true;
    options.onLoadTimeout?.();
  }, options.loadTimeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS);

  const onWindowResize = () => {
    try {
      map.resize();
    } catch {
      /* map may be removed */
    }
  };

  const resizeObserver =
    typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => {
          try {
            map.resize();
          } catch {
            /* map may be removed */
          }
        })
      : null;
  resizeObserver?.observe(options.container);

  map.on('load', () => {
    settleLoad();
    map.resize();
    options.onLoad?.(map);
  });

  map.once('idle', () => {
    options.onIdle?.(map);
  });

  map.on('error', (e) => {
    const msg = e.error?.message;
    if (!msg) {
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
      const userMsg =
        lower.includes('403') || lower.includes('forbidden') ? TILE_403_MESSAGE : msg;
      options.onTileError?.(userMsg);
    } else {
      console.warn('[mapbox] map warning:', msg);
    }
  });

  window.addEventListener('resize', onWindowResize);

  return {
    map,
    detachResize: () => {
      window.clearTimeout(loadTimeoutId);
      resizeObserver?.disconnect();
      window.removeEventListener('resize', onWindowResize);
    },
  };
}
