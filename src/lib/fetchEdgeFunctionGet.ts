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
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token ?? anonKey;
  const query = qs.toString();
  const url = `${supabaseUrl}/functions/v1/${functionName}${query ? `?${query}` : ''}`;
  const timeoutMs = options?.timeoutMs ?? 120_000;
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
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${functionName} returned ${res.status}: ${text.slice(0, 500)}`);
    }
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error(`${functionName} timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    if (err instanceof TypeError && /load failed|failed to fetch|networkerror/i.test(String(err.message))) {
      throw new Error(
        `${functionName} unreachable — check network or Supabase edge function health (${new URL(supabaseUrl).host}).`,
      );
    }
    throw err;
  } finally {
    window.clearTimeout(timer);
  }
}
