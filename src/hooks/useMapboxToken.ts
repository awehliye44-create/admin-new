import { useEffect, useState } from 'react';
import {
  getCachedMapboxToken,
  resolveMapboxToken,
  tryBootstrapMapboxTokenFromEnv,
} from '@/lib/mapbox';

function initialTokenState(): { token: string; isReady: boolean } {
  const bootstrapped = tryBootstrapMapboxTokenFromEnv();
  if (bootstrapped) return { token: bootstrapped, isReady: true };
  const cached = getCachedMapboxToken();
  if (cached) return { token: cached, isReady: true };
  return { token: '', isReady: false };
}

interface UseMapboxTokenResult {
  token: string;
  isReady: boolean;
  error: string | null;
}

/**
 * Resolves the Mapbox **web** token (pk.*) for browser map tiles and geocoding.
 * Uses VITE_MAPBOX_WEB_TOKEN when set, otherwise get-mapbox-token (MAPBOX_WEB_TOKEN).
 */
export function useMapboxToken(): UseMapboxTokenResult {
  const [initial] = useState(initialTokenState);
  const [token, setToken] = useState(initial.token);
  const [error, setError] = useState<string | null>(null);
  const [isReady, setIsReady] = useState(initial.isReady);

  useEffect(() => {
    if (token) return;
    let mounted = true;
    resolveMapboxToken()
      .then((resolved) => {
        if (!mounted) return;
        setToken(resolved);
        setError(null);
        setIsReady(true);
      })
      .catch((err: unknown) => {
        if (!mounted) return;
        const msg = err instanceof Error ? err.message : 'Failed to load Mapbox token';
        console.error('[useMapboxToken]', msg);
        setError(msg);
        setIsReady(false);
      });
    return () => {
      mounted = false;
    };
  }, [token]);

  return { token, isReady: isReady || Boolean(token), error };
}
