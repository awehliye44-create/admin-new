import { useState } from 'react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  ServiceAreaFinanceFilter,
  DEFAULT_SERVICE_AREA_SELECTION,
  type ServiceAreaFinanceSelection,
} from '@/components/finance/ServiceAreaFinanceFilter';
import {
  invokeConnectPayoutLockdown,
  useConnectPayoutStatus,
  type ConnectPayoutAccount,
} from '@/hooks/useConnectPayoutStatus';
import { formatPence } from '@/hooks/useDriverWallet';
import { toast } from 'sonner';
import { AlertTriangle, Lock, RefreshCw, ShieldCheck } from 'lucide-react';
import { format } from 'date-fns';
import { useQueryClient } from '@tanstack/react-query';

function modeBadge(account: ConnectPayoutAccount) {
  if (account.automatic_payouts_enabled) {
    return <Badge variant="destructive">Automatic</Badge>;
  }
  return <Badge variant="secondary">Manual</Badge>;
}

export default function ConnectPayoutLockdown() {
  const [filter, setFilter] = useState<ServiceAreaFinanceSelection>(DEFAULT_SERVICE_AREA_SELECTION);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const queryClient = useQueryClient();

  const { data, isLoading, isFetching, refetch, error } = useConnectPayoutStatus(filter.regionId);

  const summary = data?.summary;
  const accounts = data?.connect_accounts ?? [];
  const allManual = (summary?.automatic_count ?? 0) === 0;

  async function runDryRun() {
    setBusy(true);
    try {
      const result = await invokeConnectPayoutLockdown({
        dry_run: true,
        region_id: filter.regionId ?? undefined,
      });
      toast.success(
        result.all_manual
          ? 'Dry run: all accounts already manual'
          : `Dry run: ${result.automatic_remaining_count} account(s) would be locked down`,
      );
      await queryClient.invalidateQueries({ queryKey: ['connect-payout-status'] });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function applyLockdown() {
    setBusy(true);
    try {
      const result = await invokeConnectPayoutLockdown({
        confirm_lockdown: true,
        region_id: filter.regionId ?? undefined,
      });
      if (result.all_manual) {
        toast.success('Connect auto-payout lockdown complete — all accounts manual');
      } else {
        toast.warning(`${result.automatic_remaining_count} account(s) still automatic`);
      }
      setConfirmOpen(false);
      await queryClient.invalidateQueries({ queryKey: ['connect-payout-status'] });
      await refetch();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AdminLayout
      title="Connect Payout Lockdown"
      description="Phase 3D.3 — manual-only Connect bank payouts; admin engine is the sole driver payout path"
    >
      <div className="space-y-6">
        <ServiceAreaFinanceFilter value={filter} onChange={setFilter} />

        <div className="flex flex-wrap gap-2 items-center">
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={`h-4 w-4 mr-2 ${isFetching ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          <Button variant="outline" size="sm" onClick={runDryRun} disabled={busy}>
            <ShieldCheck className="h-4 w-4 mr-2" />
            Dry run lockdown
          </Button>
          <Button
            size="sm"
            onClick={() => setConfirmOpen(true)}
            disabled={busy || allManual}
          >
            <Lock className="h-4 w-4 mr-2" />
            Apply manual schedule
          </Button>
          {allManual && (
            <Badge variant="outline" className="text-green-700 border-green-300">
              All Connect accounts manual
            </Badge>
          )}
        </div>

        {error && (
          <Card className="border-destructive">
            <CardContent className="pt-6 text-destructive flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" />
              {(error as Error).message}
            </CardContent>
          </Card>
        )}

        <div className="grid gap-4 md:grid-cols-4">
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">Connect accounts</CardTitle></CardHeader>
            <CardContent className="text-2xl font-bold">{summary?.total ?? '—'}</CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">Automatic (risk)</CardTitle></CardHeader>
            <CardContent className="text-2xl font-bold text-destructive">{summary?.automatic_count ?? '—'}</CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">Manual (locked)</CardTitle></CardHeader>
            <CardContent className="text-2xl font-bold text-green-600">{summary?.manual_count ?? '—'}</CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">In-flight payouts</CardTitle></CardHeader>
            <CardContent className="text-2xl font-bold">{summary?.in_flight_count ?? '—'}</CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Connect accounts</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <p className="text-muted-foreground text-sm">Loading Connect payout status…</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Driver</TableHead>
                    <TableHead>Stripe account</TableHead>
                    <TableHead>Mode</TableHead>
                    <TableHead>Schedule</TableHead>
                    <TableHead className="text-right">Available</TableHead>
                    <TableHead className="text-right">Pending</TableHead>
                    <TableHead>In-flight</TableHead>
                    <TableHead>Last audit</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {accounts.map((account) => (
                    <TableRow key={account.driver_id}>
                      <TableCell>
                        <div className="font-medium">{account.driver_code ?? '—'}</div>
                        <div className="text-xs text-muted-foreground">{account.driver_name}</div>
                      </TableCell>
                      <TableCell className="font-mono text-xs">{account.stripe_account_id}</TableCell>
                      <TableCell>{modeBadge(account)}</TableCell>
                      <TableCell>
                        {account.payout_schedule_interval ?? '—'}
                        {account.payout_schedule_delay_days != null && (
                          <span className="text-muted-foreground text-xs"> · {account.payout_schedule_delay_days}d delay</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">{formatPence(account.connect_available_pence, 'GBP')}</TableCell>
                      <TableCell className="text-right">{formatPence(account.connect_pending_pence, 'GBP')}</TableCell>
                      <TableCell>
                        {account.in_flight_payouts.length === 0 ? (
                          <span className="text-muted-foreground text-sm">—</span>
                        ) : (
                          account.in_flight_payouts.map((p) => (
                            <div key={p.payout_id} className="text-xs">
                              {formatPence(p.amount_pence, 'GBP')} · {p.status}
                              {p.automatic && ' · auto'}
                              {p.orphan_risk && (
                                <Badge variant="destructive" className="ml-1 text-[10px]">orphan risk</Badge>
                              )}
                            </div>
                          ))
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {account.last_lockdown_audit
                          ? `${account.last_lockdown_audit.action} · ${format(new Date(account.last_lockdown_audit.created_at), 'dd MMM HH:mm')}`
                          : '—'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {(data?.recent_audits?.length ?? 0) > 0 && (
          <Card>
            <CardHeader><CardTitle className="text-sm">Recent lockdown audit</CardTitle></CardHeader>
            <CardContent className="text-xs space-y-2 max-h-48 overflow-y-auto">
              {data!.recent_audits.map((row) => (
                <div key={String(row.id)} className="border-b pb-1">
                  {String(row.action)} · {String(row.stripe_account_id)} · {String(row.before_interval)} → {String(row.after_interval)}
                  {row.dry_run ? ' (dry run)' : ''}
                </div>
              ))}
            </CardContent>
          </Card>
        )}
      </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Apply manual Connect payout schedule?</DialogTitle>
            <DialogDescription>
              This sets Stripe Connect payout schedule to manual for all scoped drivers.
              No bank transfers are initiated. In-flight payouts continue unchanged.
              Driver bank payouts will only occur via the admin payout engine when enabled.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={busy}>Cancel</Button>
            <Button onClick={applyLockdown} disabled={busy}>Apply lockdown</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AdminLayout>
  );
}
