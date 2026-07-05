import { ShieldCheck } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { useFinanceEra } from '@/hooks/useFinanceEra';

/** Digital Finance Era indicator — migration controls hidden after migration completes. */
export function DigitalFinanceEraPanel() {
  const { era, startedAt, loading } = useFinanceEra();

  if (loading) return null;

  if (era !== 'digital') {
    return (
      <div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-900 dark:text-amber-100">
        Finance era migration pending — contact super_admin to complete Digital Finance Era switch.
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 px-3 py-2">
      <Badge variant="default" className="gap-1">
        <ShieldCheck className="h-3 w-3" />
        Digital Finance Era
      </Badge>
      <span className="text-xs text-muted-foreground">
        Card-only settlement
        {startedAt ? ` · active since ${new Date(startedAt).toLocaleDateString()}` : ''}
      </span>
    </div>
  );
}
