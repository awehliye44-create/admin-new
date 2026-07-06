import { ShieldCheck } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

/** Digital-only finance era. */
export function DigitalFinanceEraPanel() {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 px-3 py-2">
      <Badge variant="default" className="gap-1">
        <ShieldCheck className="h-3 w-3" />
        Digital Finance Era
      </Badge>
      <span className="text-xs text-muted-foreground">
        Digital-only platform — card, mobile wallet, and future gateways only
      </span>
    </div>
  );
}
