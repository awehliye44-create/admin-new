import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/hooks/useAuth';
import { FinanceRecoveryPanel } from '@/components/payment/FinanceRecoveryPanel';
import { format } from 'date-fns';
import { getTripDisplayId } from '@/lib/tripUtils';
import {
  getServiceAreaTripCustomerPaidPence,
  getServiceAreaTripDriverNetPence,
  sumPaymentCapturedPenceForTrip,
  type ServiceAreaTripFinanceRow,
} from '@/lib/serviceAreaTripFinance';
import { Banknote, Undo2, Pencil, ShieldAlert } from 'lucide-react';

interface TripRow extends ServiceAreaTripFinanceRow {
  id: string;
  trip_number: string | null;
  trip_code: string | null;
  status: string;
  created_at: string;
  customerPaidPence: number;
  driverNetPence: number | null;
}

export function ServiceAreaTripsTab({ serviceAreaId, currencyCode = 'GBP' }: { serviceAreaId: string; currencyCode?: string }) {
  const { isAdmin } = useAuth();
  const [openTripId, setOpenTripId] = useState<string | null>(null);

  const tripsQuery = useQuery<TripRow[]>({
    queryKey: ['service-area-trips', serviceAreaId],
    enabled: !!serviceAreaId,
    queryFn: async () => {
      const { data: trips, error } = await supabase
        .from('trips')
        .select(
          'id, trip_number, trip_code, status, payment_status, payment_method, gross_fare_pence, final_fare_pence, capture_amount_pence, driver_net_pence, created_at',
        )
        .eq('service_area_id', serviceAreaId)
        .order('created_at', { ascending: false })
        .limit(100);
      if (error) throw error;

      const tripRows = trips || [];
      const tripIds = tripRows.map((trip) => trip.id);
      const paymentsByTripId = new Map<string, number>();
      const ledgerNetByTripId = new Map<string, number>();

      if (tripIds.length > 0) {
        const [paymentsRes, ledgerRes] = await Promise.all([
          supabase
            .from('payments')
            .select('trip_id, captured_amount_pence, amount_pence, status')
            .in('trip_id', tripIds),
          supabase
            .from('driver_wallet_ledger')
            .select('related_trip_id, amount_pence')
            .in('related_trip_id', tripIds)
            .eq('type', 'TRIP_EARNING_NET'),
        ]);

        if (paymentsRes.error) throw paymentsRes.error;
        if (ledgerRes.error) throw ledgerRes.error;

        const paymentsGrouped = new Map<string, Array<{
          captured_amount_pence: number | null;
          amount_pence: number | null;
          status: string | null;
        }>>();

        for (const payment of paymentsRes.data ?? []) {
          if (!payment.trip_id) continue;
          const list = paymentsGrouped.get(payment.trip_id) ?? [];
          list.push(payment);
          paymentsGrouped.set(payment.trip_id, list);
        }

        for (const [tripId, paymentRows] of paymentsGrouped) {
          const captured = sumPaymentCapturedPenceForTrip(paymentRows);
          if (captured > 0) paymentsByTripId.set(tripId, captured);
        }

        for (const entry of ledgerRes.data ?? []) {
          if (!entry.related_trip_id) continue;
          ledgerNetByTripId.set(entry.related_trip_id, entry.amount_pence);
        }
      }

      return tripRows.map((trip) => {
        const financeContext = {
          paymentCapturedPence: paymentsByTripId.get(trip.id) ?? null,
          ledgerTripEarningNetPence: ledgerNetByTripId.get(trip.id) ?? null,
        };

        return {
          ...trip,
          customerPaidPence: getServiceAreaTripCustomerPaidPence(trip, financeContext),
          driverNetPence: getServiceAreaTripDriverNetPence(trip, financeContext),
        };
      });
    },
  });

  const formatPence = useMemo(() => {
    return (pence: number) => {
      const value = pence / 100;
      try {
        return new Intl.NumberFormat('en-GB', { style: 'currency', currency: currencyCode }).format(value);
      } catch {
        return `${value.toFixed(2)} ${currencyCode}`;
      }
    };
  }, [currencyCode]);

  if (!isAdmin) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-muted-foreground flex flex-col items-center gap-2">
          <ShieldAlert className="h-5 w-5" />
          Admin role required to manage payments.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Recent trips — payment controls</CardTitle>
        <p className="text-xs text-muted-foreground">
          Latest 100 trips in this service area. Customer Paid and Driver Net use settlement SSOT (captured / cash collected).
        </p>
      </CardHeader>
      <CardContent>
        {tripsQuery.isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : !tripsQuery.data || tripsQuery.data.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">No trips found for this service area.</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Trip</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Method</TableHead>
                  <TableHead>Payment</TableHead>
                  <TableHead className="text-right">Customer Paid</TableHead>
                  <TableHead className="text-right">Driver Net</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tripsQuery.data.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell className="font-mono text-xs">{getTripDisplayId(t)}</TableCell>
                    <TableCell className="text-xs">{format(new Date(t.created_at), 'dd MMM HH:mm')}</TableCell>
                    <TableCell className="text-xs capitalize">{t.payment_method || '—'}</TableCell>
                    <TableCell><Badge variant="outline" className="text-xs">{t.payment_status || '—'}</Badge></TableCell>
                    <TableCell className="text-right text-xs font-medium">{formatPence(t.customerPaidPence)}</TableCell>
                    <TableCell className="text-right text-xs text-green-600">
                      {t.driverNetPence == null ? (
                        <span className="text-muted-foreground">Unknown</span>
                      ) : (
                        formatPence(t.driverNetPence)
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button size="sm" variant="ghost" onClick={() => setOpenTripId(t.id)} title="Capture">
                          <Banknote className="h-3.5 w-3.5" />
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setOpenTripId(t.id)} title="Refund">
                          <Undo2 className="h-3.5 w-3.5" />
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setOpenTripId(t.id)} title="Edit fare">
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>

      <Dialog open={!!openTripId} onOpenChange={(o) => !o && setOpenTripId(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Trip payment controls</DialogTitle>
          </DialogHeader>
          {openTripId && (
            <FinanceRecoveryPanel tripId={openTripId} source="payments" variant="finance" />
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
