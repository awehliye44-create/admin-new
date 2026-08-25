import { useEffect, useState, type ReactNode } from 'react';
import { Loader2, AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  ADMIN_FINANCE_SLOW_SECTION_MS,
  adminFinanceSlowSectionMessage,
} from '@/lib/adminFinanceLoadPerf';

interface LoadingTimeoutProps {
  /** Whether data is currently loading */
  isLoading: boolean;
  /** Timeout in ms before showing the "taking too long" state (default: 8s for finance) */
  timeoutMs?: number;
  /** Retry callback */
  onRetry?: () => void;
  /** Custom loading text */
  loadingText?: string;
  /**
   * Named section for the slow banner, e.g. "reconciliation audit".
   * Must not imply payment failure.
   */
  sectionLabel?: string;
  /**
   * When true and children exist, keep rendering partial UI and only show a soft banner.
   * Default false preserves legacy full-block behaviour for non-finance callers.
   */
  allowPartialContent?: boolean;
  children?: ReactNode;
}

/**
 * Wrapper that prevents endless loading states.
 * After a timeout, shows an actionable message with retry option.
 */
export function LoadingTimeout({
  isLoading,
  timeoutMs = ADMIN_FINANCE_SLOW_SECTION_MS,
  onRetry,
  loadingText = 'Loading...',
  sectionLabel,
  allowPartialContent = false,
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

  const slowTitle = 'Taking longer than expected';
  const slowBody = sectionLabel
    ? adminFinanceSlowSectionMessage(sectionLabel)
    : 'This is taking unusually long. Please check your connection or try again.';

  if (!isLoading) return <>{children}</>;

  if (timedOut && allowPartialContent && children != null) {
    return (
      <div className="space-y-3">
        <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm">
          <div className="flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 mt-0.5 text-amber-600 shrink-0" />
            <div className="space-y-1">
              <p className="font-medium text-foreground">{slowTitle}</p>
              <p className="text-muted-foreground">{slowBody}</p>
              {onRetry ? (
                <Button variant="outline" size="sm" className="mt-1" onClick={onRetry}>
                  <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                  Retry {sectionLabel ?? 'section'}
                </Button>
              ) : null}
            </div>
          </div>
        </div>
        {children}
      </div>
    );
  }

  if (timedOut) {
    return (
      <div className="flex flex-col items-center justify-center py-12 px-4 text-center space-y-4">
        <div className="w-12 h-12 rounded-full bg-warning/10 flex items-center justify-center">
          <AlertTriangle className="h-6 w-6 text-destructive" />
        </div>
        <div className="space-y-1">
          <h3 className="text-lg font-semibold text-foreground">{slowTitle}</h3>
          <p className="text-sm text-muted-foreground max-w-sm">{slowBody}</p>
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

  if (allowPartialContent && children != null) {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-sm text-muted-foreground px-1">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>{loadingText}</span>
        </div>
        {children}
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
