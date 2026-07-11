import { Link } from 'react-router-dom';
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
import type { AdminPaymentSessionsMatchingRow } from '../../../shared/adminPaymentSessionsSSOT';
import { paymentSessionsUrl } from '../../../shared/adminPaymentSessionsSSOT';
import {
  financeReconciliationTripUrl,
  tripSettlementRecoverUrl,
} from '@/lib/financialReconciliationRoutes';
import { formatNullablePence } from '@/lib/formatNullablePence';

export function PaymentSessionsMatchingTable({
  rows,
  currencyCode = 'GBP',
  onInspectProvider,
}: {
  rows: AdminPaymentSessionsMatchingRow[];
  currencyCode?: string;
  onInspectProvider?: (providerOrderId: string) => void;
}) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No matching rows in this window.</p>;
  }

  return (
    <div className="overflow-x-auto rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Trip</TableHead>
            <TableHead>Payment Session</TableHead>
            <TableHead>Customer</TableHead>
            <TableHead>Expected Capture</TableHead>
            <TableHead>Actual Capture</TableHead>
            <TableHead>Authorised</TableHead>
            <TableHead>Released</TableHead>
            <TableHead>Variance</TableHead>
            <TableHead>Reason</TableHead>
            <TableHead>Classification</TableHead>
            <TableHead>Match Status</TableHead>
            <TableHead>Provider State</TableHead>
            <TableHead>Verification</TableHead>
            <TableHead>Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell className="font-mono text-xs">
                {row.trip_code ?? (row.trip_id ? row.trip_id.slice(0, 8) : '—')}
              </TableCell>
              <TableCell className="font-mono text-xs">
                {row.payment_session_id ? row.payment_session_id.slice(0, 8) : '—'}
              </TableCell>
              <TableCell className="text-xs">{row.customer_name ?? '—'}</TableCell>
              <TableCell className="text-xs">{formatNullablePence(row.expected_capture_pence, currencyCode)}</TableCell>
              <TableCell className="text-xs">{formatNullablePence(row.actual_capture_pence, currencyCode)}</TableCell>
              <TableCell className="text-xs">{formatNullablePence(row.authorised_amount_pence, currencyCode)}</TableCell>
              <TableCell className="text-xs">{formatNullablePence(row.released_amount_pence, currencyCode)}</TableCell>
              <TableCell className="text-xs">
                {formatNullablePence(row.variance_pence, currencyCode)}
                {row.shortfall_pence != null && (
                  <div className="text-[10px] text-amber-700">
                    shortfall {formatNullablePence(row.shortfall_pence, currencyCode)}
                  </div>
                )}
                {row.overcapture_pence != null && (
                  <div className="text-[10px] text-amber-700">
                    over {formatNullablePence(row.overcapture_pence, currencyCode)}
                  </div>
                )}
              </TableCell>
              <TableCell className="text-xs max-w-[140px] truncate" title={row.variance_reason ?? undefined}>
                {row.variance_reason ?? '—'}
              </TableCell>
              <TableCell className="text-[10px] text-muted-foreground">
                {row.capture_classification ?? '—'}
              </TableCell>
              <TableCell>
                <Badge variant={row.match_status === 'MATCHED' ? 'default' : 'destructive'}>
                  {row.match_status}
                </Badge>
              </TableCell>
              <TableCell className="text-xs">{row.provider_state ?? '—'}</TableCell>
              <TableCell className="text-xs">{row.provider_verification_status ?? '—'}</TableCell>
              <TableCell>
                <div className="flex flex-wrap gap-1">
                  {row.trip_id && (
                    <Button asChild size="sm" variant="outline">
                      <Link to={tripSettlementRecoverUrl(row.trip_id, row.trip_code)}>Trip evidence</Link>
                    </Button>
                  )}
                  {row.payment_session_id && (
                    <Button asChild size="sm" variant="outline">
                      <Link to={paymentSessionsUrl({
                        tab: 'provider_payments',
                        paymentSessionId: row.payment_session_id,
                      })}
                      >
                        Provider payment
                      </Link>
                    </Button>
                  )}
                  {row.provider_order_id && onInspectProvider && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => onInspectProvider(row.provider_order_id!)}
                    >
                      Provider evidence
                    </Button>
                  )}
                  {row.trip_id && (
                    <Button asChild size="sm" variant="outline">
                      <Link to={financeReconciliationTripUrl(row.trip_id, row.trip_code)}>
                        Reconciliation
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
  );
}
