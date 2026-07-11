import { format } from 'date-fns';
import { Link } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import type { DriverWalletSsotRow, DriverWalletSettlementHistoryRow } from '@/hooks/useDriverWalletSsot';
import { getTripDisplayId } from '@/lib/tripUtils';
import { formatNullablePence } from '@/lib/formatNullablePence';
import { paymentSessionsUrl } from '../../../shared/adminPaymentSessionsSSOT';

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return format(new Date(iso), 'dd MMM yyyy HH:mm');
  } catch {
    return iso;
  }
}

/**
 * Settlement tab — one row per completed trip explaining wallet credit.
 * Customer paid comes from Payment Sessions; net/commission from trip snapshots; credit from ledger.
 */
export function DriverWalletSettlementTab({
  driver,
  currencyCode = 'GBP',
  isLoading,
}: {
  driver: DriverWalletSsotRow | null | undefined;
  currencyCode?: string;
  isLoading?: boolean;
}) {
  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-8">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading settlement history…
      </div>
    );
  }

  if (!driver) {
    return (
      <p className="text-sm text-muted-foreground py-8">
        Select a driver to view settlement history.
      </p>
    );
  }

  const rows = (driver.settlement_history ?? []) as DriverWalletSettlementHistoryRow[];

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Explains how each completed customer payment became wallet credit. Capture amounts are consumed
        from Payment Sessions; this page does not authorise, capture, or refund.
      </p>
      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Trip ID</TableHead>
              <TableHead>Completed Date</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead>Payment Provider</TableHead>
              <TableHead>Payment Method</TableHead>
              <TableHead className="text-right">Customer Paid</TableHead>
              <TableHead className="text-right">Provider Fee</TableHead>
              <TableHead className="text-right">Platform Commission</TableHead>
              <TableHead className="text-right">Driver Commission %</TableHead>
              <TableHead className="text-right">Driver Net</TableHead>
              <TableHead className="text-right">Wallet Credit</TableHead>
              <TableHead>Settlement Status</TableHead>
              <TableHead>Linked Payment Session</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={14} className="text-center text-muted-foreground py-8">
                  No settlement rows for this driver.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => (
                <TableRow key={row.settlement_id}>
                  <TableCell className="text-xs font-mono">
                    {row.trip_id
                      ? getTripDisplayId({ trip_code: row.trip_code, id: row.trip_id })
                      : '—'}
                  </TableCell>
                  <TableCell className="text-xs whitespace-nowrap">{fmtDate(row.completed_at)}</TableCell>
                  <TableCell className="text-xs">{row.customer_name ?? '—'}</TableCell>
                  <TableCell className="text-xs">{row.payment_provider ?? '—'}</TableCell>
                  <TableCell className="text-xs">{row.payment_method ?? '—'}</TableCell>
                  <TableCell className="text-xs text-right tabular-nums">
                    {formatNullablePence(row.customer_paid_pence, currencyCode)}
                  </TableCell>
                  <TableCell className="text-xs text-right tabular-nums">
                    {formatNullablePence(row.provider_fee_pence, currencyCode)}
                  </TableCell>
                  <TableCell className="text-xs text-right tabular-nums">
                    {formatNullablePence(row.platform_commission_pence, currencyCode)}
                  </TableCell>
                  <TableCell className="text-xs text-right tabular-nums">
                    {row.driver_commission_percent != null ? `${row.driver_commission_percent}%` : '—'}
                  </TableCell>
                  <TableCell className="text-xs text-right tabular-nums">
                    {formatNullablePence(row.driver_net_pence, currencyCode)}
                  </TableCell>
                  <TableCell className="text-xs text-right tabular-nums font-medium">
                    {formatNullablePence(row.wallet_credit_pence, currencyCode)}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{row.settlement_status ?? '—'}</Badge>
                  </TableCell>
                  <TableCell className="text-xs font-mono">
                    {row.payment_session_id ? row.payment_session_id.slice(0, 8) : '—'}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      {row.trip_id ? (
                        <Button variant="outline" size="sm" asChild>
                          <Link to={`/active-trips?tripId=${encodeURIComponent(row.trip_id)}`}>
                            Open Trip
                          </Link>
                        </Button>
                      ) : null}
                      {row.payment_session_id ? (
                        <Button variant="outline" size="sm" asChild>
                          <Link to={paymentSessionsUrl({ paymentSessionId: row.payment_session_id })}>
                            Open Payment Session
                          </Link>
                        </Button>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
