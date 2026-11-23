import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { Car, FileText, History, Loader2, RefreshCw } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  describeAuditAction,
  describeAuditActor,
  formatAuditChangeValue,
  labelAuditField,
  type ComplianceAuditEntityFilter,
} from '@/lib/driverComplianceAudit';

interface AuditRow {
  id: string;
  entity_type: string;
  entity_id: string;
  entity_label: string | null;
  action: string;
  changes: Record<string, { from: unknown; to: unknown }> | null;
  actor_kind: string;
  actor_name: string | null;
  actor_username: string | null;
  actor_user_id: string | null;
  source: string;
  created_at: string;
}

const FILTERS: { value: ComplianceAuditEntityFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'document', label: 'Documents' },
  { value: 'vehicle', label: 'Vehicles' },
];

export function DriverComplianceAuditLog({ driverId }: { driverId: string }) {
  const [filter, setFilter] = useState<ComplianceAuditEntityFilter>('all');

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['driver-compliance-audit', driverId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('driver_compliance_audit_log')
        .select('id, entity_type, entity_id, entity_label, action, changes, actor_kind, actor_name, actor_username, actor_user_id, source, created_at')
        .eq('driver_id', driverId)
        .order('created_at', { ascending: false })
        .limit(500);
      if (error) throw error;
      return (data ?? []) as unknown as AuditRow[];
    },
  });

  const rows = useMemo(() => {
    const all = data ?? [];
    if (filter === 'all') return all;
    if (filter === 'document') return all.filter((r) => r.entity_type === 'document');
    return all.filter((r) => r.entity_type === 'vehicle' || r.entity_type === 'vehicle_change_request');
  }, [data, filter]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex gap-1">
          {FILTERS.map((f) => (
            <Button
              key={f.value}
              size="sm"
              variant={filter === f.value ? 'default' : 'outline'}
              onClick={() => setFilter(f.value)}
            >
              {f.label}
            </Button>
          ))}
        </div>
        <Button size="sm" variant="ghost" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className={`h-4 w-4 mr-1 ${isFetching ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : error ? (
        <div className="p-4 rounded-lg border border-destructive/40 bg-destructive/10 text-sm text-destructive">
          Could not load the audit log: {(error as Error).message}
        </div>
      ) : rows.length === 0 ? (
        <div className="text-center py-8 text-muted-foreground">
          <History className="h-10 w-10 mx-auto mb-2 opacity-30" />
          <p className="text-sm">No changes recorded yet.</p>
        </div>
      ) : (
        <ol className="space-y-2">
          {rows.map((row) => {
            const action = describeAuditAction(row.action);
            const changes = Object.entries(row.changes ?? {});
            const isDoc = row.entity_type === 'document';
            return (
              <li key={row.id} className="p-3 border rounded-lg space-y-2">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    {isDoc ? (
                      <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                    ) : (
                      <Car className="h-4 w-4 text-muted-foreground shrink-0" />
                    )}
                    <span className="font-medium text-sm truncate">
                      {row.entity_label || (isDoc ? 'Document' : 'Vehicle')}
                    </span>
                    <Badge variant={action.tone}>{action.label}</Badge>
                  </div>
                  <span className="text-xs text-muted-foreground whitespace-nowrap">
                    {format(new Date(row.created_at), 'dd MMM yyyy, HH:mm')}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  By <span className="font-medium text-foreground">{describeAuditActor(row)}</span>
                  {row.source === 'backfill' && (
                    <Badge variant="outline" className="ml-2 text-[10px]">From earlier records</Badge>
                  )}
                </p>
                {changes.length > 0 && (
                  <ul className="text-xs space-y-1 bg-muted/50 rounded p-2">
                    {changes.map(([field, change]) => (
                      <li key={field}>
                        <span className="font-medium">{labelAuditField(field)}:</span>{' '}
                        <span className="text-muted-foreground line-through">
                          {formatAuditChangeValue(field, change?.from)}
                        </span>{' '}
                        → <span>{formatAuditChangeValue(field, change?.to)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
