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
import {
  financeReconciliationTripUrl,
  tripSettlementRecoverUrl,
} from '@/lib/financialReconciliationRoutes';
import { formatNullablePence } from '@/lib/formatNullablePence';

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
    <div className="overflow-x-auto rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Trip ID</TableHead>
            <TableHead>Completed At</TableHead>
            <TableHead>Customer</TableHead>
            <TableHead>Driver</TableHead>
            <TableHead>Service Area</TableHead>
            <TableHead>Final Customer Fare</TableHead>
            <TableHead>Ride Fare</TableHead>
            <TableHead>Airport Charge</TableHead>
            <TableHead>Tips</TableHead>
            <TableHead>Expected Capture</TableHead>
            <TableHead>Linked Payment Session</TableHead>
            <TableHead>Payment Provider</TableHead>
            <TableHead>Provider Captured</TableHead>
            <TableHead>Provider Released</TableHead>
            <TableHead>Shortfall / Overcapture</TableHead>
            <TableHead>Match Status</TableHead>
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
              <TableCell className="text-xs">{row.driver_name ?? '—'}</TableCell>
              <TableCell className="text-xs">{row.service_area_name ?? '—'}</TableCell>
              <TableCell className="text-xs">{formatNullablePence(row.final_customer_fare_pence, currencyCode)}</TableCell>
              <TableCell className="text-xs">{formatNullablePence(row.ride_fare_pence, currencyCode)}</TableCell>
              <TableCell className="text-xs">{formatNullablePence(row.airport_charge_pence, currencyCode)}</TableCell>
              <TableCell className="text-xs">{formatNullablePence(row.tips_pence, currencyCode)}</TableCell>
              <TableCell className="text-xs">{formatNullablePence(row.expected_capture_pence, currencyCode)}</TableCell>
              <TableCell className="font-mono text-xs">
                {row.payment_session_id ? row.payment_session_id.slice(0, 8) : '—'}
              </TableCell>
              <TableCell className="text-xs">{row.payment_provider ?? '—'}</TableCell>
              <TableCell className="text-xs">{formatNullablePence(row.provider_captured_pence, currencyCode)}</TableCell>
              <TableCell className="text-xs">{formatNullablePence(row.provider_released_pence, currencyCode)}</TableCell>
              <TableCell className="text-xs">{formatNullablePence(row.shortfall_overcapture_pence, currencyCode)}</TableCell>
              <TableCell>
                <Badge variant={row.match_status === 'MATCHED' ? 'default' : 'secondary'}>
                  {row.match_status}
                </Badge>
              </TableCell>
              <TableCell>
                <div className="flex flex-wrap gap-1">
                  <Button asChild size="sm" variant="outline">
                    <Link to={tripSettlementRecoverUrl(row.trip_id, row.trip_code)}>Open Trip</Link>
                  </Button>
                  {row.payment_session_id && (
                    <Button asChild size="sm" variant="outline">
                      <Link to={paymentSessionsUrl({
                        tab: 'provider_payments',
                        paymentSessionId: row.payment_session_id,
                      })}
                      >
                        Open Provider Payment
                      </Link>
                    </Button>
                  )}
                  <Button asChild size="sm" variant="outline">
                    <Link to={financeReconciliationTripUrl(row.trip_id, row.trip_code)}>
                      Financial Reconciliation
                    </Link>
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
