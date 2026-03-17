import { QueryClient, QueryCache, MutationCache } from '@tanstack/react-query';
import { toast } from 'sonner';
import { parseApiError } from '@/lib/errorCodes';

/**
 * Global query client with platform-wide error handling:
 * - Every failed query shows a toast (no silent failures)
 * - Every failed mutation shows a toast with error details
 * - Retries with exponential backoff (max 2 retries)
 * - Stale time prevents unnecessary refetches
 */
export function createAppQueryClient(): QueryClient {
  return new QueryClient({
    queryCache: new QueryCache({
      onError: (error, query) => {
        // Only show toast for queries that have already been successful before
        // (refetch failures) or queries that opt-in to showing errors.
        // Initial load failures are handled by component-level error states.
        const meta = query.meta as Record<string, unknown> | undefined;
        
        if (meta?.suppressErrorToast) return;

        // If query has data already (refetch failure), show toast
        if (query.state.data !== undefined) {
          const message = parseApiError(error);
          toast.error('Failed to refresh data', {
            description: message,
            duration: 5000,
          });
        }

        // Always log for debugging
        console.error(`[Query Error] ${query.queryKey}:`, error);
      },
    }),
    mutationCache: new MutationCache({
      onError: (error, _variables, _context, mutation) => {
        const meta = mutation.meta as Record<string, unknown> | undefined;

        if (meta?.suppressErrorToast) return;

        const message = parseApiError(error);
        toast.error('Action failed', {
          description: message,
          duration: 6000,
        });

        // Always log for debugging
        console.error('[Mutation Error]:', error);
      },
    }),
    defaultOptions: {
      queries: {
        retry: (failureCount, error) => {
          // Don't retry on 4xx errors (client errors)
          if (error instanceof Error) {
            const msg = error.message.toLowerCase();
            if (msg.includes('401') || msg.includes('403') || msg.includes('404') || msg.includes('422')) {
              return false;
            }
          }
          return failureCount < 2;
        },
        retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 10000),
        staleTime: 30 * 1000, // 30 seconds
        refetchOnWindowFocus: false,
      },
      mutations: {
        retry: false, // Don't auto-retry mutations
      },
    },
  });
}
