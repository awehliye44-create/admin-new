/**
 * Payment Sessions Completed Trips table — presence / provider amounts only.
 * Fare settlement stamps and FR conclusions are owned by Financial Reconciliation.
 */
import { Link } from 'react-router-dom';
import { format } from 'date-fns';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { AdminPaymentSessionsCompletedTripRow } from '../../../shared/adminPaymentSessionsSSOT';
import { paymentSessionsUrl } from '../../../shared/adminPaymentSessionsSSOT';
import { isPaymentSessionsAmountsOnFrStatus } from '../../../shared/paymentSessionsTripMatchSSOT';
import { financeReconciliationTripUrl } from '@/lib/financialReconciliationRoutes';
import { formatNullablePence } from '@/lib/formatNullablePence';

function matchBadgeVariant(status: string | null | undefined): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (!status || isPaymentSessionsAmountsOnFrStatus(status)) return 'outline';
  if (String(status).includes('MISSING') || String(status).includes('PENDING')) return 'secondary';
  return 'secondary';
}

/** @deprecated Prefer Financial Reconciliation for trip-vs-payment audit. Kept for deep-link compatibility. */
export function PaymentSessionsCompletedTripsTable({
  rows,
  currencyCode = 'GBP',
}: {
  rows: AdminPaymentSessionsCompletedTripRow[];
  currencyCode?: string;
}) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No completed trips in this window.</p>;
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Payment Sessions provider amounts only. Trip fare / settlement / reconciliation conclusions:
        open Financial Reconciliation.
      </p>
      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Trip ID</TableHead>
              <TableHead>Completed At</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead>Provider Captured</TableHead>
              <TableHead>Refunded</TableHead>
              <TableHead>Released</TableHead>
              <TableHead>Presence</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="font-mono text-xs">
                  {row.trip_code ?? row.trip_id.slice(0, 8)}
                </TableCell>
                <TableCell className="text-xs">
                  {row.completed_at ? format(new Date(row.completed_at), 'dd MMM yyyy HH:mm') : '—'}
                </TableCell>
                <TableCell className="text-xs">{row.customer_name ?? '—'}</TableCell>
                <TableCell className="text-xs tabular-nums">
                  {formatNullablePence(row.provider_captured_pence, currencyCode)}
                </TableCell>
                <TableCell className="text-xs tabular-nums">
                  {formatNullablePence(row.provider_refunded_pence, currencyCode)}
                </TableCell>
                <TableCell className="text-xs tabular-nums">
                  {formatNullablePence(row.provider_released_pence, currencyCode)}
                </TableCell>
                <TableCell>
                  {!isPaymentSessionsAmountsOnFrStatus(row.match_status) && row.match_status ? (
                    <Badge variant={matchBadgeVariant(row.match_status)} className="text-[10px] w-fit">
                      {row.match_status}
                    </Badge>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    <Button asChild size="sm" variant="outline">
                      <Link to={financeReconciliationTripUrl(row.trip_id, row.trip_code)}>
                        Financial Reconciliation
                      </Link>
                    </Button>
                    {row.payment_session_id && (
                      <Button asChild size="sm" variant="outline">
                        <Link to={paymentSessionsUrl({
                          paymentSessionId: row.payment_session_id,
                        })}
                        >
                          Open Provider Payment
                        </Link>
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
