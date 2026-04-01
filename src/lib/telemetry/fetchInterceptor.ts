/**
 * ONECAB Telemetry — Fetch Interceptor
 * ======================================
 * Wraps the global fetch to automatically track API latency
 * for requests to the Supabase backend. Zero manual wiring needed.
 */

import type { OnecabTelemetry } from './core';

/**
 * Install a global fetch interceptor that records api_latency
 * for every Supabase REST/Edge Function call.
 *
 * Call once at app startup:
 *   installFetchInterceptor(telemetry, supabaseUrl);
 */
export function installFetchInterceptor(
  client: OnecabTelemetry,
  supabaseUrl: string,
  /** Screen name to attribute; defaults to deriving from current pathname */
  defaultScreen?: string,
) {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async function interceptedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

    // Only track Supabase calls
    if (!url.startsWith(supabaseUrl)) {
      return originalFetch(input, init);
    }

    const start =
      typeof performance !== 'undefined' ? performance.now() : Date.now();

    try {
      const response = await originalFetch(input, init);

      const elapsed =
        (typeof performance !== 'undefined' ? performance.now() : Date.now()) -
        start;

      // Extract operation name from URL path
      const path = new URL(url).pathname;
      const operation = path
        .replace('/rest/v1/', 'rest:')
        .replace('/functions/v1/', 'fn:')
        .replace('/rpc/', 'rpc:')
        .split('?')[0];

      const screen =
        defaultScreen ??
        (typeof window !== 'undefined'
          ? window.location.pathname.replace(/^\//, '') || 'Home'
          : 'Unknown');

      client.trackApiLatency(screen, elapsed, operation);

      return response;
    } catch (err) {
      const elapsed =
        (typeof performance !== 'undefined' ? performance.now() : Date.now()) -
        start;

      const screen =
        defaultScreen ??
        (typeof window !== 'undefined'
          ? window.location.pathname.replace(/^\//, '') || 'Home'
          : 'Unknown');

      client.trackError(screen, elapsed, 'FETCH_FAILED', (err as Error).message);
      throw err;
    }
  };

  return () => {
    globalThis.fetch = originalFetch;
  };
}
