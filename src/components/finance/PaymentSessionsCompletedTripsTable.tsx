import { useState } from 'react';
import { Link } from 'react-router-dom';
import { format } from 'date-fns';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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

function matchBadgeVariant(status: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'MATCHED') return 'default';
  if (status.includes('OVERCAPTURE') || status.includes('SHORTFALL') || status.includes('MISSING')) {
    return 'destructive';
  }
  return 'secondary';
}

function BreakdownLine({
  label,
  value,
  currencyCode,
}: {
  label: string;
  value: number | null | undefined;
  currencyCode: string;
}) {
  return (
    <div className="flex justify-between gap-4 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums">{formatNullablePence(value, currencyCode)}</span>
    </div>
  );
}

export function PaymentSessionsCompletedTripsTable({
  rows,
  currencyCode = 'GBP',
}: {
  rows: AdminPaymentSessionsCompletedTripRow[];
  currencyCode?: string;
}) {
  const [drawer, setDrawer] = useState<AdminPaymentSessionsCompletedTripRow | null>(null);

  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No completed trips in this window.</p>;
  }

  return (
    <div className="space-y-4">
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
              <TableHead>Waiting Charges</TableHead>
              <TableHead>Other Payment Components</TableHead>
              <TableHead>Expected Capture</TableHead>
              <TableHead>Provider Captured</TableHead>
              <TableHead>Variance</TableHead>
              <TableHead>Reason</TableHead>
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
                <TableCell className="text-xs">
                  {formatNullablePence(row.final_customer_fare_pence, currencyCode)}
                </TableCell>
                <TableCell className="text-xs">
                  {formatNullablePence(row.waiting_charges_pence, currencyCode)}
                </TableCell>
                <TableCell className="text-xs">
                  {formatNullablePence(row.other_payment_components_pence, currencyCode)}
                </TableCell>
                <TableCell className="text-xs">
                  {formatNullablePence(row.expected_capture_pence, currencyCode)}
                </TableCell>
                <TableCell className="text-xs">
                  {formatNullablePence(row.provider_captured_pence, currencyCode)}
                </TableCell>
                <TableCell className="text-xs">
                  {formatNullablePence(row.variance_pence ?? row.shortfall_overcapture_pence, currencyCode)}
                </TableCell>
                <TableCell className="text-xs max-w-[140px] truncate" title={row.variance_reason ?? undefined}>
                  {row.variance_reason ?? '—'}
                </TableCell>
                <TableCell>
                  <div className="flex flex-col gap-0.5">
                    <Badge variant={matchBadgeVariant(row.match_status)} className="text-[10px] w-fit">
                      {row.match_status}
                    </Badge>
                    {row.capture_classification ? (
                      <span className="text-[10px] text-muted-foreground">{row.capture_classification}</span>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    <Button size="sm" variant="outline" onClick={() => setDrawer(row)}>
                      Breakdown
                    </Button>
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

      <Dialog open={!!drawer} onOpenChange={(open) => !open && setDrawer(null)}>
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
          {drawer && (
            <>
              <DialogHeader>
                <DialogTitle>
                  Capture breakdown — {drawer.trip_code ?? drawer.trip_id.slice(0, 8)}
                </DialogTitle>
                <DialogDescription>
                  Payment Sessions SSOT — every captured penny explained. Formatting only in UI.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-2 rounded-md border p-3 bg-muted/20">
                <BreakdownLine label="Ride fare" value={drawer.capture_breakdown?.ride_fare_pence ?? drawer.ride_fare_pence} currencyCode={currencyCode} />
                <BreakdownLine label="Pickup waiting" value={drawer.capture_breakdown?.pickup_waiting_charge_pence ?? drawer.pickup_waiting_charge_pence} currencyCode={currencyCode} />
                <BreakdownLine label="Stop waiting" value={drawer.capture_breakdown?.stop_waiting_charge_pence ?? drawer.stop_waiting_charge_pence} currencyCode={currencyCode} />
                <BreakdownLine label="No-show" value={drawer.capture_breakdown?.no_show_charge_pence ?? drawer.no_show_charge_pence} currencyCode={currencyCode} />
                <BreakdownLine label="Airport" value={drawer.capture_breakdown?.airport_charge_pence ?? drawer.airport_charge_pence} currencyCode={currencyCode} />
                <BreakdownLine label="Toll" value={drawer.capture_breakdown?.toll_charge_pence} currencyCode={currencyCode} />
                <BreakdownLine label="Parking" value={drawer.capture_breakdown?.parking_charge_pence} currencyCode={currencyCode} />
                <BreakdownLine label="Extras" value={drawer.capture_breakdown?.extra_stop_charge_pence} currencyCode={currencyCode} />
                <BreakdownLine label="Manual adjustment" value={drawer.capture_breakdown?.manual_adjustment_pence} currencyCode={currencyCode} />
                <BreakdownLine label="Destination change" value={drawer.capture_breakdown?.destination_change_pence} currencyCode={currencyCode} />
                <BreakdownLine label="Tip" value={drawer.capture_breakdown?.tip_pence ?? drawer.tips_pence} currencyCode={currencyCode} />
                <BreakdownLine label="Other" value={drawer.capture_breakdown?.other_payment_component_pence} currencyCode={currencyCode} />
                <div className="border-t pt-2 mt-2 space-y-2">
                  <BreakdownLine label="Expected capture" value={drawer.expected_capture_pence} currencyCode={currencyCode} />
                  <BreakdownLine label="Provider captured" value={drawer.provider_captured_pence} currencyCode={currencyCode} />
                  <BreakdownLine label="Variance" value={drawer.variance_pence ?? drawer.shortfall_overcapture_pence} currencyCode={currencyCode} />
                </div>
                <p className="text-xs pt-2">
                  <span className="text-muted-foreground">Reason: </span>
                  {drawer.variance_reason ?? '—'}
                </p>
                <p className="text-xs">
                  <span className="text-muted-foreground">Classification: </span>
                  {drawer.capture_classification ?? '—'}
                </p>
                <p className="text-xs">
                  <span className="text-muted-foreground">Reconciliation: </span>
                  {drawer.match_status}
                </p>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
