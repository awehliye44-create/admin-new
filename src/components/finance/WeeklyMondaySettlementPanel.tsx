import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { AlertTriangle, Calendar, Play, RefreshCw } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { supabase } from '@/integrations/supabase/client';
import { formatPence } from '@/hooks/useDriverWallet';
import type { ServiceAreaFinanceSelection } from '@/components/finance/ServiceAreaFinanceFilter';
import { toast } from 'sonner';

type SettlementDriverResult = {
  driver_id: string;
  driver_name?: string | null;
  status: 'READY' | 'BLOCKED' | 'FAILED' | 'SKIPPED';
  net_payable_pence?: number;
  failure_reason?: string;
  failure_code?: string;
  payout_warning_reasons?: string[];
  payout_blocked_reasons?: string[];
  payout_item_id?: string;
};

type SettlementResponse = {
  success: boolean;
  dry_run?: boolean;
  batch_id?: string;
  batch_status?: string;
  total_amount_pence?: number;
  ready_count?: number;
  blocked_count?: number;
  failed_count?: number;
  warning_count?: number;
  results?: SettlementDriverResult[];
  error?: string;
};

export function WeeklyMondaySettlementPanel({
  filter,
  currencyCode,
}: {
  filter: ServiceAreaFinanceSelection;
  currencyCode: string;
}) {
  const [lastResult, setLastResult] = useState<SettlementResponse | null>(null);

  const runSettlement = useMutation({
    mutationFn: async (dryRun: boolean) => {
      const { data, error } = await supabase.functions.invoke('admin-weekly-monday-settlement', {
        body: {
          region_id: filter.regionId ?? undefined,
          dry_run: dryRun,
        },
      });
      if (error) throw error;
      if (!data?.success) throw new Error(data?.error ?? 'Settlement failed');
      return data as SettlementResponse;
    },
    onSuccess: (data, dryRun) => {
      setLastResult(data);
      toast.success(
        dryRun
          ? `Dry run complete — ${data.ready_count ?? 0} drivers ready, ${data.total_amount_pence ?? 0}p total`
          : `Weekly batch created — ${data.batch_id}`,
      );
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const results = lastResult?.results ?? [];
  const ready = results.filter((r) => r.status === 'READY');
  const blocked = results.filter((r) => r.status === 'BLOCKED');
  const warned = results.filter((r) => (r.payout_warning_reasons?.length ?? 0) > 0);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-4">
        <div>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Calendar className="h-5 w-5" />
            Weekly Monday Settlement
          </CardTitle>
          <p className="text-sm text-muted-foreground mt-1">
            Dry run simulates eligibility. Create batch writes payout_items only — no Stripe transfers in this phase.
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
          <Button
            variant="outline"
            size="sm"
            disabled={runSettlement.isPending}
            onClick={() => runSettlement.mutate(true)}
          >
            {runSettlement.isPending ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4 mr-1" />}
            Dry Run
          </Button>
          <Button
            size="sm"
            disabled={runSettlement.isPending}
            onClick={() => runSettlement.mutate(false)}
          >
            Create Weekly Batch
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {lastResult && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
            <Stat label="Ready drivers" value={String(lastResult.ready_count ?? ready.length)} />
            <Stat label="Hard blocked" value={String(lastResult.blocked_count ?? blocked.length)} />
            <Stat label="Soft warnings" value={String(lastResult.warning_count ?? warned.length)} />
            <Stat
              label="Total ready"
              value={formatPence(lastResult.total_amount_pence ?? 0, currencyCode)}
            />
            {lastResult.batch_id && (
              <div className="col-span-full text-xs text-muted-foreground">
                Batch: <code>{lastResult.batch_id}</code> · status {lastResult.batch_status}
                {lastResult.dry_run && ' · dry run (no DB writes)'}
              </div>
            )}
          </div>
        )}

        {results.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Driver</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Ready amount</TableHead>
                <TableHead>Blocks / Warnings</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {results.map((row) => (
                <TableRow key={row.driver_id}>
                  <TableCell className="font-mono text-xs">{row.driver_id.slice(0, 8)}…</TableCell>
                  <TableCell>
                    <Badge variant={row.status === 'READY' ? 'default' : row.status === 'BLOCKED' ? 'destructive' : 'secondary'}>
                      {row.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    {formatPence(row.net_payable_pence ?? 0, currencyCode)}
                  </TableCell>
                  <TableCell className="text-xs max-w-[240px]">
                    {row.payout_blocked_reasons?.map((r) => (
                      <p key={r} className="text-destructive">{r}</p>
                    ))}
                    {row.payout_warning_reasons?.map((r) => (
                      <p key={r} className="text-amber-700 flex items-center gap-1">
                        <AlertTriangle className="h-3 w-3" /> {r}
                      </p>
                    ))}
                    {row.failure_reason && <p className="text-muted-foreground">{row.failure_reason}</p>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold">{value}</p>
    </div>
  );
}
