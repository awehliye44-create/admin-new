import { useState } from 'react';
import { MoreHorizontal } from 'lucide-react';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatPence } from '@/hooks/useDriverWallet';
import { useDriverWalletSsot, type DriverWalletSsotRow } from '@/hooks/useDriverWalletSsot';

function statusVariant(status: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'BALANCED') return 'default';
  if (status === 'LOCAL_ONLY' || status === 'STRIPE_ONLY') return 'secondary';
  return 'destructive';
}

function diffPence(row: DriverWalletSsotRow): number {
  const owed = row.current_onecab_wallet_owed_pence;
  const connect = row.stripe_connect_available_pence ?? 0;
  return owed - connect;
}

function SsotDetailDrawer({
  row,
  open,
  onOpenChange,
  currencyCode,
}: {
  row: DriverWalletSsotRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currencyCode: string;
}) {
  if (!row) return null;
  const fmt = (p: number) => formatPence(p, currencyCode);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {row.driver_code ?? row.driver_id.slice(0, 8)}
            {' '}
            — SSOT detail
          </DialogTitle>
        </DialogHeader>
        <div className="mt-4 space-y-4 text-sm">
          <div>
            <p className="font-medium">IDs</p>
            <p className="text-muted-foreground break-all">driver_id: {row.driver_id}</p>
            <p className="text-muted-foreground break-all">user_id: {row.user_id ?? '—'}</p>
            <p className="text-muted-foreground break-all">connected_account_id: {row.connected_account_id ?? '—'}</p>
          </div>
          <div>
            <p className="font-medium">Amounts</p>
            <ul className="text-muted-foreground space-y-1">
              <li>ONECAB wallet owed: {fmt(row.current_onecab_wallet_owed_pence)}</li>
              <li>Finance cleared: {fmt(row.finance_cleared_amount_pence)}</li>
              <li>In payout batch: {fmt(row.included_in_payout_batch_amount_pence)}</li>
              <li>Stripe pending: {row.stripe_connect_pending_pence != null ? fmt(row.stripe_connect_pending_pence) : '—'}</li>
              <li>Stripe in transit: {row.stripe_in_transit_pence != null ? fmt(row.stripe_in_transit_pence) : '—'}</li>
              <li>Stripe paid out: {fmt(row.stripe_paid_out_total_pence)}</li>
              <li>Recovery debt: {fmt(row.recovery_debt_pence)}</li>
              <li>Cash-out limit: {fmt(row.cashout_limit_pence)}</li>
            </ul>
          </div>
          {row.reconciliation_reasons?.length ? (
            <div>
              <p className="font-medium text-destructive">Mismatch explanations</p>
              <ul className="list-disc pl-4 text-muted-foreground">
                {row.reconciliation_reasons.map((r) => <li key={r}>{r}</li>)}
              </ul>
            </div>
          ) : null}
          <div>
            <p className="font-medium">Ledger ({row.ledger_rows?.length ?? 0} recent)</p>
            <ul className="text-xs text-muted-foreground space-y-1 max-h-32 overflow-y-auto">
              {(row.ledger_rows ?? []).slice(0, 15).map((lr, idx) => (
                <li key={`${String(lr.id ?? idx)}`} className="border-b pb-1">
                  {String(lr.type)} · {fmt(Number(lr.amount_pence ?? 0))}
                  {lr.trip_id ? ` · trip ${String(lr.trip_id).slice(0, 8)}` : ''}
                  {lr.stripe_payout_id ? ` · po ${String(lr.stripe_payout_id)}` : ''}
                  {lr.balance_transaction_id ? ` · bt ${String(lr.balance_transaction_id).slice(0, 12)}` : ''}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <p className="font-medium">Settlements ({row.settlements?.length ?? 0})</p>
            <ul className="text-xs text-muted-foreground space-y-1 max-h-32 overflow-y-auto">
              {(row.settlements ?? []).slice(0, 15).map((s) => (
                <li key={String(s.id)} className="border-b pb-1">
                  {String(s.settlement_status)} · trip {String(s.trip_id ?? '—').slice(0, 8)}
                  {s.allocated_to_payout ? ' · allocated' : ''}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <p className="font-medium">Payout items ({row.payout_items?.length ?? 0})</p>
            <ul className="text-xs text-muted-foreground space-y-2 max-h-40 overflow-y-auto">
              {(row.payout_items ?? []).slice(0, 10).map((pi) => (
                <li key={String(pi.id)} className="border-b pb-1">
                  {String(pi.id).slice(0, 8)} · {String(pi.status)} · {fmt(Number(pi.net_driver_payout_pence ?? pi.amount_pence ?? 0))}
                  {pi.stripe_transfer_id ? ` · tr: ${String(pi.stripe_transfer_id)}` : ''}
                  {pi.stripe_payout_id ? ` · po: ${String(pi.stripe_payout_id)}` : ''}
                  {pi.failure_reason ? ` · ${String(pi.failure_reason).slice(0, 60)}` : ''}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <p className="font-medium">Stripe Connect payouts ({row.stripe_connect_payouts?.length ?? 0})</p>
            <ul className="text-xs text-muted-foreground space-y-2 max-h-40 overflow-y-auto">
              {(row.stripe_connect_payouts ?? []).map((sp) => (
                <li key={String(sp.payout_id)} className="border-b pb-1">
                  {String(sp.payout_id)} · {fmt(Number(sp.amount_pence ?? 0))} · {String(sp.status)}
                  {sp.initiated_at ? ` · ${String(sp.initiated_at).slice(0, 16)}` : ''}
                  {sp.bank_last4 ? ` · ···${String(sp.bank_last4)}` : ''}
                </li>
              ))}
            </ul>
          </div>
          <p className="text-xs text-muted-foreground">Last synced: {row.last_synced_at ?? '—'}</p>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function DriverWalletSsotPanel({ currencyCode = 'GBP' }: { currencyCode?: string }) {
  const { data: rows = [], isLoading, error, refetch } = useDriverWalletSsot();
  const [detail, setDetail] = useState<DriverWalletSsotRow | null>(null);

  const fmt = (p: number | null | undefined) => (
    p == null ? '—' : formatPence(p, currencyCode)
  );

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle className="text-base">Driver Wallet Ledger (SSOT)</CardTitle>
          <p className="text-sm text-muted-foreground mt-1">
            Each column from a distinct source — wallet balance is ONECAB liability only, not Stripe cash or cash-out.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()}>Refresh</Button>
      </CardHeader>
      <CardContent>
        {isLoading ? <p className="text-sm text-muted-foreground">Loading SSOT…</p> : null}
        {error ? <p className="text-sm text-destructive">{(error as Error).message}</p> : null}
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Driver</TableHead>
                <TableHead>Connect</TableHead>
                <TableHead>ONECAB owed</TableHead>
                <TableHead>Finance cleared</TableHead>
                <TableHead>In batch</TableHead>
                <TableHead>Stripe avail.</TableHead>
                <TableHead>Stripe pending</TableHead>
                <TableHead>Stripe in transit</TableHead>
                <TableHead>Stripe paid</TableHead>
                <TableHead>Recovery</TableHead>
                <TableHead>Cash-out limit</TableHead>
                <TableHead>Diff</TableHead>
                <TableHead>Status</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.driver_id}>
                  <TableCell className="font-medium">{row.driver_code ?? row.driver_id.slice(0, 8)}</TableCell>
                  <TableCell className="text-xs">{row.connected_account_id?.slice(-8) ?? '—'}</TableCell>
                  <TableCell>{fmt(row.current_onecab_wallet_owed_pence)}</TableCell>
                  <TableCell>{fmt(row.finance_cleared_amount_pence)}</TableCell>
                  <TableCell>{fmt(row.included_in_payout_batch_amount_pence)}</TableCell>
                  <TableCell>{fmt(row.stripe_connect_available_pence)}</TableCell>
                  <TableCell>{fmt(row.stripe_connect_pending_pence)}</TableCell>
                  <TableCell>{fmt(row.stripe_in_transit_pence)}</TableCell>
                  <TableCell>{fmt(row.stripe_paid_out_total_pence)}</TableCell>
                  <TableCell>{fmt(row.recovery_debt_pence)}</TableCell>
                  <TableCell>{fmt(row.cashout_limit_pence)}</TableCell>
                  <TableCell>{fmt(diffPence(row))}</TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(row.reconciliation_status)}>
                      {row.reconciliation_status}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Button variant="ghost" size="icon" onClick={() => setDetail(row)} aria-label="Details">
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <SsotDetailDrawer
          row={detail}
          open={Boolean(detail)}
          onOpenChange={(o) => !o && setDetail(null)}
          currencyCode={currencyCode}
        />
      </CardContent>
    </Card>
  );
}
