import { useCallback } from 'react';
import { toast } from 'sonner';
import { parseApiError, type ApiErrorResponse } from '@/lib/errorCodes';

/**
 * Hook for handling edge function / API responses consistently.
 * Ensures no silent failures: every error gets surfaced to the user.
 * 
 * Usage:
 *   const { handleResponse } = useApiError();
 *   const { data, error } = await supabase.functions.invoke('my-fn', { body });
 *   const result = handleResponse(data, error, 'Action description');
 */
export function useApiError() {
  const handleResponse = useCallback(<T = unknown>(
    data: T | null,
    error: unknown,
    actionLabel?: string
  ): { ok: true; data: T } | { ok: false; error: string } => {
    // Network / invocation error
    if (error) {
      const message = parseApiError(error);
      toast.error(actionLabel ? `${actionLabel} failed` : 'Action failed', {
        description: message,
        duration: 6000,
      });
      console.error(`[API Error] ${actionLabel || 'unknown'}:`, error);
      return { ok: false, error: message };
    }

    // Structured API error response (success: false)
    if (data && typeof data === 'object' && 'success' in data && !(data as any).success) {
      const apiError = data as unknown as ApiErrorResponse;
      const message = parseApiError(apiError);
      toast.error(actionLabel ? `${actionLabel} failed` : 'Action failed', {
        description: message,
        duration: 6000,
      });
      console.error(`[API Error] ${actionLabel || 'unknown'}:`, apiError);
      return { ok: false, error: message };
    }

    // No data at all
    if (data === null || data === undefined) {
      const message = 'No response received from server.';
      toast.error(actionLabel ? `${actionLabel} failed` : 'Action failed', {
        description: message,
        duration: 6000,
      });
      return { ok: false, error: message };
    }

    return { ok: true, data: data as T };
  }, []);

  return { handleResponse };
}
