import { useEffect, useState } from 'react';
import { format } from 'date-fns';
import { ChevronLeft, ChevronRight, Loader2, MoreHorizontal } from 'lucide-react';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatPence } from '@/hooks/useDriverWallet';
import {
  useDriverWalletSsot,
  useDriverWalletSsotDetail,
  type DriverWalletSsotRow,
} from '@/hooks/useDriverWalletSsot';

const PAGE_SIZE = 25;

function statusVariant(status: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'BALANCED') return 'default';
  if (status === 'LOCAL_ONLY' || status === 'STRIPE_ONLY') return 'secondary';
  return 'destructive';
}

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return format(new Date(iso), 'dd MMM yyyy HH:mm');
  } catch {
    return iso;
  }
}

function driverLabel(row: Pick<DriverWalletSsotRow, 'driver_code' | 'driver_name' | 'driver_id'>): string {
  if (row.driver_name) return row.driver_name;
  if (row.driver_code) return row.driver_code;
  return row.driver_id.slice(0, 8);
}

function DetailRow({
  label,
  value,
  mono,
  highlight,
}: {
  label: string;
  value: string;
  mono?: boolean;
  highlight?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5 border-b border-border/50 last:border-0">
      <span className="text-muted-foreground text-sm shrink-0">{label}</span>
      <span className={`text-sm text-right ${mono ? 'font-mono text-xs' : ''} ${highlight ? 'font-semibold' : ''}`}>
        {value}
      </span>
    </div>
  );
}

function SsotDetailDrawer({
  driverId,
  open,
  onOpenChange,
  currencyCode,
  listRow,
}: {
  driverId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currencyCode: string;
  listRow: DriverWalletSsotRow | null;
}) {
  const { data: detail, isLoading, error } = useDriverWalletSsotDetail(open ? driverId : null);
  const row = detail ?? listRow;
  const fmt = (p: number | null | undefined) => (p == null ? '—' : formatPence(p, currencyCode));

  if (!open) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {row ? driverLabel(row) : 'Driver'}
            {' '}
            — payout &amp; ledger SSOT
          </DialogTitle>
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-8">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading full SSOT detail…
          </div>
        ) : null}
        {error ? (
          <p className="text-sm text-destructive">{(error as Error).message}</p>
        ) : null}

        {row ? (
          <div className="mt-2 space-y-6 text-sm">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="rounded-lg border p-3 space-y-0">
                <p className="font-medium mb-2">ONECAB wallet (liability)</p>
                <DetailRow label="Wallet owed (≥0)" value={fmt(row.current_onecab_wallet_owed_pence)} highlight />
                <DetailRow label="Ledger balance (signed)" value={fmt(row.wallet_balance_pence)} mono />
                <DetailRow label="Finance cleared" value={fmt(row.finance_cleared_amount_pence)} />
                <DetailRow label="Scheduled batch" value={fmt(row.scheduled_payout_display_pence ?? row.included_in_payout_batch_amount_pence)} />
                <DetailRow label="Recovery debt" value={fmt(row.recovery_debt_pence)} />
              </div>
              <div className="rounded-lg border p-3 space-y-0">
                <p className="font-medium mb-2">Stripe Connect</p>
                <DetailRow label="Available" value={fmt(row.stripe_connect_available_pence)} />
                <DetailRow label="Pending" value={fmt(row.stripe_connect_pending_pence)} />
                <DetailRow label="In transit" value={fmt(row.stripe_in_transit_pence)} />
                <DetailRow label="Paid out (total)" value={fmt(row.stripe_paid_out_total_pence)} />
                <DetailRow label="Cash-out limit" value={fmt(row.cashout_limit_pence)} />
                <DetailRow
                  label="Last payout"
                  value={
                    row.last_payout_at
                      ? `${fmt(row.last_payout_amount_pence)} · ${formatDateTime(row.last_payout_at)}`
                      : '—'
                  }
                />
              </div>
            </div>

            <div className="rounded-lg border p-3">
              <p className="font-medium mb-2">Reconciliation</p>
              <div className="flex items-center gap-2 mb-2">
                <Badge variant={statusVariant(row.reconciliation_status)}>{row.reconciliation_status}</Badge>
                <span className="text-xs text-muted-foreground">
                  Failed payouts: {fmt(row.local_only_failed_payout_pence)}
                  {row.failed_payout_stuck_processing_pence > 0
                    ? ` · stuck processing: ${fmt(row.failed_payout_stuck_processing_pence)}`
                    : ''}
                </span>
              </div>
              {row.reconciliation_reasons?.length ? (
                <ul className="list-disc pl-4 text-muted-foreground space-y-1">
                  {row.reconciliation_reasons.map((r) => <li key={r}>{r}</li>)}
                </ul>
              ) : (
                <p className="text-muted-foreground">No mismatch explanations.</p>
              )}
            </div>

            <div>
              <p className="font-medium mb-1">IDs</p>
              <p className="text-muted-foreground break-all text-xs">driver_id: {row.driver_id}</p>
              <p className="text-muted-foreground break-all text-xs">user_id: {row.user_id ?? '—'}</p>
              <p className="text-muted-foreground break-all text-xs">connected_account_id: {row.connected_account_id ?? '—'}</p>
            </div>

            <div>
              <p className="font-medium mb-2">Ledger rows ({row.ledger_rows?.length ?? 0})</p>
              <ul className="text-xs text-muted-foreground space-y-1 max-h-48 overflow-y-auto border rounded-md p-2">
                {(row.ledger_rows ?? []).map((lr, idx) => (
                  <li key={`${String(lr.id ?? idx)}`} className="border-b pb-1 last:border-0">
                    {formatDateTime(String(lr.created_at ?? ''))}
                    {' · '}
                    {String(lr.type)}
                    {' · '}
                    {fmt(Number(lr.amount_pence ?? 0))}
                    {lr.trip_id ? ` · trip ${String(lr.trip_id).slice(0, 8)}` : ''}
                    {lr.stripe_payout_id ? ` · ${String(lr.stripe_payout_id)}` : ''}
                  </li>
                ))}
              </ul>
            </div>

            <div>
              <p className="font-medium mb-2">Payout items ({row.payout_items?.length ?? 0})</p>
              <ul className="text-xs text-muted-foreground space-y-1 max-h-48 overflow-y-auto border rounded-md p-2">
                {(row.payout_items ?? []).map((pi) => (
                  <li key={String(pi.id)} className="border-b pb-1 last:border-0">
                    {String(pi.id).slice(0, 8)}
                    {' · '}
                    {String(pi.status)}
                    {' · '}
                    {fmt(Number(pi.net_driver_payout_pence ?? pi.amount_pence ?? 0))}
                    {pi.stripe_transfer_id ? ` · tr ${String(pi.stripe_transfer_id)}` : ''}
                    {pi.stripe_payout_id ? ` · po ${String(pi.stripe_payout_id)}` : ''}
                    {pi.failure_reason ? ` · ${String(pi.failure_reason).slice(0, 80)}` : ''}
                  </li>
                ))}
              </ul>
            </div>

            <div>
              <p className="font-medium mb-2">Stripe Connect payouts ({row.stripe_connect_payouts?.length ?? 0})</p>
              <ul className="text-xs text-muted-foreground space-y-1 max-h-48 overflow-y-auto border rounded-md p-2">
                {(row.stripe_connect_payouts ?? []).map((sp) => (
                  <li key={String(sp.payout_id)} className="border-b pb-1 last:border-0">
                    {String(sp.payout_id)}
                    {' · '}
                    {fmt(Number(sp.amount_pence ?? 0))}
                    {' · '}
                    {String(sp.status)}
                    {sp.initiated_at ? ` · ${formatDateTime(String(sp.initiated_at))}` : ''}
                    {sp.bank_last4 ? ` · ···${String(sp.bank_last4)}` : ''}
                  </li>
                ))}
              </ul>
            </div>

            <div>
              <p className="font-medium mb-2">Settlements ({row.settlements?.length ?? 0})</p>
              <ul className="text-xs text-muted-foreground space-y-1 max-h-40 overflow-y-auto border rounded-md p-2">
                {(row.settlements ?? []).map((s) => (
                  <li key={String(s.id)} className="border-b pb-1 last:border-0">
                    {String(s.settlement_status)}
                    {' · trip '}
                    {String(s.trip_id ?? '—').slice(0, 8)}
                    {s.allocated_to_payout ? ' · allocated' : ''}
                  </li>
                ))}
              </ul>
            </div>

            <p className="text-xs text-muted-foreground">Last synced: {row.last_synced_at ?? '—'}</p>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export function DriverWalletSsotPanel({
  currencyCode = 'GBP',
  regionId = null,
}: {
  currencyCode?: string;
  regionId?: string | null;
}) {
  const [page, setPage] = useState(1);
  const [detailDriverId, setDetailDriverId] = useState<string | null>(null);
  const [detailListRow, setDetailListRow] = useState<DriverWalletSsotRow | null>(null);

  useEffect(() => {
    setPage(1);
  }, [regionId]);

  const { data, isLoading, error, refetch, isFetching } = useDriverWalletSsot({
    regionId,
    page,
    pageSize: PAGE_SIZE,
  });

  const rows = data?.drivers ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const fmt = (p: number | null | undefined) => (
    p == null ? '—' : formatPence(p, currencyCode)
  );

  const openDetail = (row: DriverWalletSsotRow) => {
    setDetailListRow(row);
    setDetailDriverId(row.driver_id);
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-4">
        <div>
          <CardTitle className="text-base">Driver Wallet Ledger (SSOT)</CardTitle>
          <p className="text-sm text-muted-foreground mt-1">
            Each column from a distinct source — wallet balance is ONECAB liability only, not Stripe cash or cash-out.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
          {isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Refresh'}
        </Button>
      </CardHeader>
      <CardContent>
        {isLoading ? <p className="text-sm text-muted-foreground">Loading SSOT…</p> : null}
        {error ? <p className="text-sm text-destructive">{(error as Error).message}</p> : null}

        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Driver</TableHead>
                <TableHead className="text-right">ONECAB liability</TableHead>
                <TableHead className="text-right">Finance cleared</TableHead>
                <TableHead className="text-right">Scheduled batch</TableHead>
                <TableHead className="text-right">Stripe avail.</TableHead>
                <TableHead className="text-right">Stripe paid</TableHead>
                <TableHead className="text-right">Failed payouts</TableHead>
                <TableHead className="text-right">Recovery debt</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Last payout</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 && !isLoading ? (
                <TableRow>
                  <TableCell colSpan={11} className="text-center text-muted-foreground py-8">
                    No drivers with Connect accounts in this region.
                  </TableCell>
                </TableRow>
              ) : null}
              {rows.map((row) => (
                <TableRow key={row.driver_id}>
                  <TableCell>
                    <div className="font-medium">{driverLabel(row)}</div>
                    <div className="text-xs text-muted-foreground">{row.driver_code ?? row.driver_id.slice(0, 8)}</div>
                  </TableCell>
                  <TableCell className="text-right">{fmt(row.current_onecab_wallet_owed_pence)}</TableCell>
                  <TableCell className="text-right">{fmt(row.finance_cleared_amount_pence)}</TableCell>
                  <TableCell className="text-right">
                    {fmt(row.scheduled_payout_display_pence ?? row.included_in_payout_batch_amount_pence)}
                  </TableCell>
                  <TableCell className="text-right">{fmt(row.stripe_connect_available_pence)}</TableCell>
                  <TableCell className="text-right">{fmt(row.stripe_paid_out_total_pence)}</TableCell>
                  <TableCell className="text-right">{fmt(row.local_only_failed_payout_pence)}</TableCell>
                  <TableCell className="text-right">{fmt(row.recovery_debt_pence)}</TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(row.reconciliation_status)}>
                      {row.reconciliation_status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs whitespace-nowrap">
                    {row.last_payout_at ? (
                      <>
                        <div>{fmt(row.last_payout_amount_pence)}</div>
                        <div className="text-muted-foreground">{formatDateTime(row.last_payout_at)}</div>
                      </>
                    ) : '—'}
                  </TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" aria-label="Actions">
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => openDetail(row)}>
                          Payout &amp; ledger details
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        {total > PAGE_SIZE ? (
          <div className="flex items-center justify-between mt-4 text-sm">
            <p className="text-muted-foreground">
              Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} of {total} drivers
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1 || isFetching}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                <ChevronLeft className="h-4 w-4" />
                Previous
              </Button>
              <span className="text-muted-foreground tabular-nums">
                Page {page} of {totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= totalPages || isFetching}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                Next
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        ) : total > 0 ? (
          <p className="text-xs text-muted-foreground mt-3">{total} driver{total === 1 ? '' : 's'} with Connect</p>
        ) : null}

        <SsotDetailDrawer
          driverId={detailDriverId}
          listRow={detailListRow}
          open={Boolean(detailDriverId)}
          onOpenChange={(o) => {
            if (!o) {
              setDetailDriverId(null);
              setDetailListRow(null);
            }
          }}
          currencyCode={currencyCode}
        />
      </CardContent>
    </Card>
  );
}
