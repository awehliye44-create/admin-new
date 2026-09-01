import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { History, Loader2, RefreshCw } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

type AuditRow = {
  id: string;
  service_area_id: string | null;
  zone_id: string | null;
  actor_id: string | null;
  actor_role: string | null;
  action: string;
  field_key: string | null;
  old_value: Record<string, unknown> | null;
  new_value: Record<string, unknown> | null;
  reason: string | null;
  created_at: string;
};

interface Props {
  serviceAreaId: string;
}

function summariseRow(row: AuditRow): string {
  if (row.action === 'level_confirmed') {
    const oldLevel = (row.old_value?.confirmed_demand_level as string | undefined) ?? '—';
    const newLevel = (row.new_value?.confirmed_demand_level as string | undefined) ?? '—';
    const trips = row.new_value?.open_trip_count;
    const tripsLabel = typeof trips === 'number' ? ` (${trips} open trips)` : '';
    return `Confirmed level ${oldLevel} → ${newLevel}${tripsLabel}`;
  }
  if (row.action === 'settings_update' || row.action === 'settings_updated') {
    if (row.field_key) {
      return `Setting "${row.field_key}" updated`;
    }
    const keys = row.new_value ? Object.keys(row.new_value) : [];
    return keys.length ? `Updated ${keys.slice(0, 4).join(', ')}${keys.length > 4 ? '…' : ''}` : 'Settings updated';
  }
  if (row.field_key) {
    return `${row.field_key} changed`;
  }
  return row.reason ?? row.action;
}

export function DemandZoneAuditPanel({ serviceAreaId }: Props) {
  const scoped = serviceAreaId && serviceAreaId !== 'all';

  const { data: rows = [], isLoading, refetch, isFetching } = useQuery({
    queryKey: ['demand-zone-audit', serviceAreaId],
    queryFn: async () => {
      let q = supabase
        .from('demand_zone_audit_log')
        .select('id, service_area_id, zone_id, actor_id, actor_role, action, field_key, old_value, new_value, reason, created_at')
        .order('created_at', { ascending: false })
        .limit(100);
      if (scoped) {
        q = q.eq('service_area_id', serviceAreaId);
      }
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as AuditRow[];
    },
  });

  return (
    <div className="rounded-lg border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
        <div>
          <h3 className="font-semibold text-sm flex items-center gap-2">
            <History className="h-4 w-4" />
            Demand zone audit
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Level confirmations and settings changes
            {scoped ? ' for the selected service area' : ' across all service areas'}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
          {isFetching ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
          Refresh
        </Button>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12 text-muted-foreground">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" />
          Loading audit…
        </div>
      ) : rows.length === 0 ? (
        <div className="py-12 text-center text-sm text-muted-foreground">
          No audit events yet for this scope.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[150px]">When</TableHead>
                <TableHead className="w-[140px]">Action</TableHead>
                <TableHead>Summary</TableHead>
                <TableHead className="w-[100px]">Reason</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                    {format(new Date(row.created_at), 'MMM d, HH:mm:ss')}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="text-[10px] uppercase">
                      {row.action.replace(/_/g, ' ')}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm">{summariseRow(row)}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{row.reason ?? '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
