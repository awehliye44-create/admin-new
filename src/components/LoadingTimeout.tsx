import { useEffect, useState } from 'react';
import { Loader2, AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface LoadingTimeoutProps {
  /** Whether data is currently loading */
  isLoading: boolean;
  /** Timeout in ms before showing the "taking too long" state (default: 15s) */
  timeoutMs?: number;
  /** Retry callback */
  onRetry?: () => void;
  /** Custom loading text */
  loadingText?: string;
  children: React.ReactNode;
}

/**
 * Wrapper that prevents endless loading states.
 * After a timeout, shows an actionable message with retry option.
 */
export function LoadingTimeout({
  isLoading,
  timeoutMs = 15000,
  onRetry,
  loadingText = 'Loading...',
  children,
}: LoadingTimeoutProps) {
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    if (!isLoading) {
      setTimedOut(false);
      return;
    }

    const timer = setTimeout(() => setTimedOut(true), timeoutMs);
    return () => clearTimeout(timer);
  }, [isLoading, timeoutMs]);

  if (!isLoading) return <>{children}</>;

  if (timedOut) {
    return (
      <div className="flex flex-col items-center justify-center py-12 px-4 text-center space-y-4">
        <div className="w-12 h-12 rounded-full bg-warning/10 flex items-center justify-center">
          <AlertTriangle className="h-6 w-6 text-yellow-600" />
        </div>
        <div className="space-y-1">
          <h3 className="text-lg font-semibold text-foreground">Taking longer than expected</h3>
          <p className="text-sm text-muted-foreground max-w-sm">
            This is taking unusually long. Please check your connection or try again.
          </p>
        </div>
        {onRetry && (
          <Button variant="outline" onClick={onRetry}>
            <RefreshCw className="h-4 w-4 mr-2" />
            Try Again
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center py-12 text-center space-y-3">
      <Loader2 className="h-8 w-8 animate-spin text-primary" />
      <p className="text-sm text-muted-foreground">{loadingText}</p>
    </div>
  );
}
