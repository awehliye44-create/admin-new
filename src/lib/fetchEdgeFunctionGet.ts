import { supabase } from '@/integrations/supabase/client';

/**
 * GET an edge function with query params.
 * supabase.functions.invoke() URL-encodes `?` in the function name and breaks routing.
 */
export async function fetchEdgeFunctionGet<T>(
  functionName: string,
  params?: Record<string, string | undefined | null>,
  extraHeaders?: Record<string, string>,
  options?: { timeoutMs?: number },
): Promise<T> {
  const qs = new URLSearchParams();
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value != null && value !== '') qs.set(key, value);
    }
  }
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
  const anonKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string;
  let { data: sessionData } = await supabase.auth.getSession();
  let session = sessionData.session;
  // Force refresh if token is missing or expired/near-expiry (<30s left)
  const nowSec = Math.floor(Date.now() / 1000);
  if (session && (!session.expires_at || session.expires_at - nowSec < 30)) {
    const { data: refreshed } = await supabase.auth.refreshSession();
    session = refreshed.session ?? session;
  }
  const query = qs.toString();
  const url = `${supabaseUrl}/functions/v1/${functionName}${query ? `?${query}` : ''}`;
  const timeoutMs = options?.timeoutMs ?? 120_000;

  const doFetch = async (token: string) => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${token}`,
          apikey: anonKey,
          'Content-Type': 'application/json',
          ...extraHeaders,
        },
      });
      return res;
    } finally {
      window.clearTimeout(timer);
    }
  };

  try {
    let token = session?.access_token ?? anonKey;
    let res = await doFetch(token);

    // One session refresh + retry on 401 only (no loop).
    if (res.status === 401 && session?.access_token) {
      const { data: refreshed } = await supabase.auth.refreshSession();
      const next = refreshed.session?.access_token;
      if (next && next !== token) {
        token = next;
        res = await doFetch(token);
      }
    }

    if (!res.ok) {
      const text = await res.text();
      if (res.status === 401) {
        throw new Error(`${functionName} returned 401: Admin session expired — sign in again. ${text.slice(0, 300)}`);
      }
      if (res.status === 403) {
        throw new Error(
          `${functionName} returned 403: You do not have Financial Reconciliation permission (slug: financial-reconciliation). ${text.slice(0, 300)}`,
        );
      }
      if (res.status === 404) {
        throw new Error(`${functionName} returned 404: Financial Reconciliation backend is not deployed. ${text.slice(0, 300)}`);
      }
      throw new Error(`${functionName} returned ${res.status}: ${text.slice(0, 500)}`);
    }
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error(`${functionName} timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    if (err instanceof TypeError && /load failed|failed to fetch|networkerror/i.test(String(err.message))) {
      throw new Error(
        `${functionName} unreachable — check network, CORS, or Supabase edge function health (${new URL(supabaseUrl).host}).`,
      );
    }
    throw err;
  }
}
