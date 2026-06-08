/**
 * Centralized Mapbox configuration.
 * Imports the Mapbox GL CSS once and exports the access token + a default style.
 *
 * Browser maps must use the **web** token (MAPBOX_WEB_TOKEN / get-mapbox-token).
 * VITE_MAPBOX_PUBLIC_TOKEN is the native token and returns 403 for web tile requests.
 */
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import '@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css';
import { supabase } from '@/integrations/supabase/client';

export const MAPBOX_STYLE = 'mapbox://styles/mapbox/streets-v12';

export { mapboxgl };

let cachedToken: string | null = null;
let inflight: Promise<string> | null = null;

function readEnvWebToken(): string | undefined {
  const raw = import.meta.env.VITE_MAPBOX_WEB_TOKEN as string | undefined;
  const token = raw?.trim();
  return token?.startsWith('pk.') ? token : undefined;
}

/** Apply VITE_MAPBOX_WEB_TOKEN synchronously (dev/build-time). Returns null if unset. */
export function tryBootstrapMapboxTokenFromEnv(): string | null {
  const envToken = readEnvWebToken();
  if (!envToken) return null;
  return applyToken(envToken);
}

function applyToken(token: string): string {
  cachedToken = token;
  mapboxgl.accessToken = token;
  return token;
}

const MAPBOX_TOKEN_MISSING_MSG =
  'Mapbox web token missing. Set VITE_MAPBOX_WEB_TOKEN locally or MAPBOX_WEB_TOKEN on Supabase.';

/** Public edge fn (verify_jwt=false): direct fetch avoids SDK "Failed to send a request" flakes. */
async function fetchMapboxTokenFromEdge(): Promise<string> {
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const anonKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

  if (supabaseUrl && anonKey) {
    try {
      const response = await fetch(`${supabaseUrl}/functions/v1/get-mapbox-token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: anonKey,
          Authorization: `Bearer ${anonKey}`,
        },
        body: JSON.stringify({ platform: 'web' }),
      });
      const payload = (await response.json().catch(() => null)) as {
        token?: string;
        error?: string;
        message?: string;
      } | null;
      if (response.ok) {
        const token = payload?.token?.trim();
        if (token?.startsWith('pk.')) return token;
      } else {
        const detail =
          payload?.error?.trim() ||
          payload?.message?.trim() ||
          `get-mapbox-token failed (HTTP ${response.status})`;
        console.warn('[mapbox] direct edge fetch:', detail);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'direct fetch failed';
      console.warn('[mapbox] direct edge fetch threw:', msg);
    }
  }

  const { data, error } = await supabase.functions.invoke('get-mapbox-token', {
    body: { platform: 'web' },
  });
  if (error) {
    throw new Error(error.message || 'Failed to fetch Mapbox token');
  }
  const token = (data as { token?: string } | null)?.token?.trim();
  if (!token?.startsWith('pk.')) {
    throw new Error(MAPBOX_TOKEN_MISSING_MSG);
  }
  return token;
}

export function getCachedMapboxToken(): string | null {
  return cachedToken;
}

/** @deprecated Use resolveMapboxToken() or useMapboxToken(); sync value is empty until resolved. */
export const MAPBOX_TOKEN = '';

/**
 * Returns a Mapbox public token allowed for this admin web origin.
 * Prefers VITE_MAPBOX_WEB_TOKEN, then Supabase get-mapbox-token (MAPBOX_WEB_TOKEN).
 */
export async function resolveMapboxToken(): Promise<string> {
  if (cachedToken) return cachedToken;

  const envToken = readEnvWebToken();
  if (envToken) return applyToken(envToken);

  if (import.meta.env.DEV) {
    const publicRaw = import.meta.env.VITE_MAPBOX_PUBLIC_TOKEN as string | undefined;
    const webRaw = import.meta.env.VITE_MAPBOX_WEB_TOKEN as string | undefined;
    if (publicRaw?.trim().startsWith('pk.') && !webRaw?.trim()) {
      console.warn(
        '[mapbox] VITE_MAPBOX_WEB_TOKEN is unset but VITE_MAPBOX_PUBLIC_TOKEN is set. ' +
          'Admin maps need the web token in .env.local (or MAPBOX_WEB_TOKEN on Supabase).',
      );
    }
    if (
      webRaw?.trim().startsWith('pk.') &&
      publicRaw?.trim().startsWith('pk.') &&
      webRaw.trim() === publicRaw.trim()
    ) {
      console.warn(
        '[mapbox] VITE_MAPBOX_WEB_TOKEN is identical to VITE_MAPBOX_PUBLIC_TOKEN (native). ' +
          'Browser map tiles often return 403 — create a separate URL-restricted web token in Mapbox dashboard.',
      );
    }
  }

  if (inflight) return inflight;

  inflight = (async () => {
    const token = await fetchMapboxTokenFromEdge();
    return applyToken(token);
  })().finally(() => {
    inflight = null;
  });

  return inflight;
}
