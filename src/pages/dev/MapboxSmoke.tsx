import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { createMapboxMap } from '@/lib/mapboxMap';

/**
 * Unauthenticated map smoke page — dev/CI only (see App.tsx route guard).
 */
export default function MapboxSmoke() {
  const mapRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!mapRef.current) return;
    let cancelled = false;
    let detachResize: (() => void) | undefined;

    void (async () => {
      try {
        const { map, detachResize: detach } = await createMapboxMap({
          container: mapRef.current!,
          onLoad: () => {
            if (!cancelled) setLoaded(true);
          },
          onTileError: (msg) => {
            if (!cancelled) setError(msg);
          },
        });
        if (cancelled) {
          map.remove();
          detach();
          return;
        }
        detachResize = detach;
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Map init failed');
        }
      }
    })();

    return () => {
      cancelled = true;
      detachResize?.();
    };
  }, []);

  return (
    <div className="min-h-screen bg-background p-4" data-testid="mapbox-smoke">
      <h1 className="mb-2 text-lg font-semibold">Mapbox smoke (dev)</h1>
      {error && (
        <div role="alert" className="mb-2 text-sm text-destructive">
          {error}
        </div>
      )}
      <div className="relative min-h-[500px] h-[calc(100vh-120px)] w-full rounded-lg border">
        <div ref={mapRef} className="absolute inset-0" data-testid="mapbox-smoke-container" />
        {!loaded && !error && (
          <div className="absolute inset-0 flex items-center justify-center text-muted-foreground">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" />
            Loading map…
          </div>
        )}
      </div>
    </div>
  );
}
