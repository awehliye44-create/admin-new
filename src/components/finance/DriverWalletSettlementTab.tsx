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
import { isDriverCreditExceptionHealth } from '../../../shared/driverCreditMonitoringSSOT';

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
  exceptionsOnly = false,
}: {
  driver: DriverWalletSsotRow | null | undefined;
  currencyCode?: string;
  isLoading?: boolean;
  exceptionsOnly?: boolean;
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
  const displayRows = exceptionsOnly
    ? rows.filter((row) => isDriverCreditExceptionHealth(row.driver_credit_health))
    : rows;

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
              <TableHead className="text-right">Expected Credit</TableHead>
              <TableHead className="text-right">Actual Credit</TableHead>
              <TableHead className="text-right">Credit Diff</TableHead>
              <TableHead>Credit Health</TableHead>
              <TableHead className="text-right">Wallet Credit</TableHead>
              <TableHead>Eligibility</TableHead>
              <TableHead>Settlement Status</TableHead>
              <TableHead>Linked Payment Session</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {displayRows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={19} className="text-center text-muted-foreground py-8">
                  No settlement rows for this driver.
                </TableCell>
              </TableRow>
            ) : (
              displayRows.map((row) => (
                <TableRow
                  key={row.settlement_id}
                  className={row.is_diagnostic_projection ? 'bg-destructive/5' : undefined}
                >
                  <TableCell className="text-xs font-mono">
                    {row.is_diagnostic_projection ? (
                      <span className="text-destructive">{row.diagnostic_label ?? 'Missing credit'}</span>
                    ) : row.trip_id
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
                  <TableCell className="text-xs text-right tabular-nums">
                    {formatNullablePence(row.expected_driver_credit_pence, currencyCode)}
                  </TableCell>
                  <TableCell className="text-xs text-right tabular-nums">
                    {formatNullablePence(row.actual_driver_credit_pence, currencyCode)}
                  </TableCell>
                  <TableCell className="text-xs text-right tabular-nums font-medium">
                    {formatNullablePence(row.credit_difference_pence, currencyCode)}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={isDriverCreditExceptionHealth(row.driver_credit_health) ? 'destructive' : 'outline'}
                    >
                      {row.driver_credit_health ?? '—'}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs text-right tabular-nums font-medium">
                    {formatNullablePence(row.wallet_credit_pence, currencyCode)}
                  </TableCell>
                  <TableCell className="text-xs whitespace-nowrap">
                    {fmtDate(row.credit_eligibility_at)}
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
                          <Link to={`/financial-reconciliation?tripId=${encodeURIComponent(row.trip_id)}&tab=trips`}>
                            Open FR
                          </Link>
                        </Button>
                      ) : null}
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
