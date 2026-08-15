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
import { isPaymentSessionsAmountsOnFrStatus } from '../../../shared/paymentSessionsTripMatchSSOT';
import {
  financeReconciliationTripUrl,
  tripSettlementRecoverUrl,
} from '@/lib/financialReconciliationRoutes';
import { formatNullablePence } from '@/lib/formatNullablePence';

function matchBadgeVariant(status: string | null | undefined): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (!status || isPaymentSessionsAmountsOnFrStatus(status)) return 'outline';
  if (String(status).includes('MISSING') || String(status).includes('PENDING')) return 'secondary';
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
      <p className="text-xs text-muted-foreground">
        Trip Fare / Settlement stamps + Payment Sessions amounts. Reconciliation conclusions: Open FR.
      </p>
      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Trip ID</TableHead>
              <TableHead>Completed At</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead>Driver</TableHead>
              <TableHead>Service Area</TableHead>
              <TableHead>Ride fare</TableHead>
              <TableHead>Waiting</TableHead>
              <TableHead>Final payable</TableHead>
              <TableHead>Provider Captured</TableHead>
              <TableHead>Refunded</TableHead>
              <TableHead>Settlement net</TableHead>
              <TableHead>Presence</TableHead>
              <TableHead>Reconciliation</TableHead>
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
                <TableCell className="text-xs tabular-nums">
                  {formatNullablePence(row.ride_fare_pence ?? row.final_customer_fare_pence, currencyCode)}
                </TableCell>
                <TableCell className="text-xs tabular-nums">
                  {formatNullablePence(row.waiting_charges_pence, currencyCode)}
                </TableCell>
                <TableCell className="text-xs font-medium tabular-nums">
                  {formatNullablePence(row.final_fare_pence ?? row.expected_capture_pence, currencyCode)}
                </TableCell>
                <TableCell className="text-xs tabular-nums">
                  {formatNullablePence(row.provider_captured_pence, currencyCode)}
                </TableCell>
                <TableCell className="text-xs tabular-nums">
                  {formatNullablePence(row.provider_refunded_pence, currencyCode)}
                </TableCell>
                <TableCell className="text-xs tabular-nums">
                  {formatNullablePence(row.driver_net_pence, currencyCode)}
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
                <TableCell className="text-xs">
                  <Link
                    className="underline text-muted-foreground"
                    to={financeReconciliationTripUrl(row.trip_id, row.trip_code)}
                  >
                    Open FR
                  </Link>
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
                  Owned stamps — {drawer.trip_code ?? drawer.trip_id.slice(0, 8)}
                </DialogTitle>
                <DialogDescription>
                  Trip Fare + Settlement stamps and Payment Sessions provider amounts. No fare rebuild.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-2 rounded-md border p-3 bg-muted/20">
                <p className="text-[10px] font-medium text-muted-foreground uppercase">Trip Fare SSOT</p>
                <BreakdownLine label="Original / locked (audit)" value={drawer.original_locked_fare_pence} currencyCode={currencyCode} />
                <BreakdownLine label="Preset quote (audit only)" value={drawer.accepted_preset_offer_fare_pence} currencyCode={currencyCode} />
                <BreakdownLine label="Ride fare (excl. waiting)" value={drawer.ride_fare_pence ?? drawer.final_customer_fare_pence} currencyCode={currencyCode} />
                <BreakdownLine label="Pickup waiting" value={drawer.pickup_waiting_charge_pence} currencyCode={currencyCode} />
                <BreakdownLine label="Stop waiting" value={drawer.stop_waiting_charge_pence} currencyCode={currencyCode} />
                <BreakdownLine label="Modification audit (not re-added)" value={drawer.modification_audit_pence} currencyCode={currencyCode} />
                <BreakdownLine label="Airport / other non-mod" value={drawer.other_payment_components_pence} currencyCode={currencyCode} />
                <BreakdownLine label="Tip" value={drawer.tips_pence} currencyCode={currencyCode} />
                <BreakdownLine label="Final payable" value={drawer.final_fare_pence ?? drawer.expected_capture_pence} currencyCode={currencyCode} />
                <div className="border-t pt-2 mt-2 space-y-2">
                  <p className="text-[10px] font-medium text-muted-foreground uppercase">Settlement SSOT</p>
                  <BreakdownLine label="Commissionable" value={drawer.commissionable_fare_pence} currencyCode={currencyCode} />
                  <BreakdownLine label="Commission" value={drawer.commission_pence} currencyCode={currencyCode} />
                  <BreakdownLine label="Driver net" value={drawer.driver_net_pence} currencyCode={currencyCode} />
                </div>
                <div className="border-t pt-2 mt-2 space-y-2">
                  <p className="text-[10px] font-medium text-muted-foreground uppercase">Payment Sessions</p>
                  <BreakdownLine label="Provider captured" value={drawer.provider_captured_pence} currencyCode={currencyCode} />
                  <BreakdownLine label="Provider refunded" value={drawer.provider_refunded_pence} currencyCode={currencyCode} />
                  <BreakdownLine label="Provider released" value={drawer.provider_released_pence} currencyCode={currencyCode} />
                </div>
                <p className="text-xs pt-2">
                  <span className="text-muted-foreground">Presence: </span>
                  {isPaymentSessionsAmountsOnFrStatus(drawer.match_status)
                    ? '—'
                    : (drawer.match_status ?? '—')}
                </p>
                <p className="text-xs">
                  <Link
                    className="underline"
                    to={financeReconciliationTripUrl(drawer.trip_id, drawer.trip_code)}
                  >
                    Open FR for reconciliation conclusions
                  </Link>
                </p>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
