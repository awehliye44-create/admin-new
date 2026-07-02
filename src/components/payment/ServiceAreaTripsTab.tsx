import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/hooks/useAuth';
import { FinancialReconciliationTripLink } from '@/components/finance/FinancialReconciliationTripLink';
import { financeReconciliationTripUrl } from '@/components/payment/FinanceRecoveryPanel';
import { format } from 'date-fns';
import { getTripDisplayId } from '@/lib/tripUtils';
import { Calculator, ShieldAlert } from 'lucide-react';

interface TripRow {
  id: string;
  trip_number: string | null;
  trip_code: string | null;
  status: string;
  payment_status: string | null;
  payment_method: string | null;
  created_at: string;
}

export function ServiceAreaTripsTab({ serviceAreaId }: { serviceAreaId: string; currencyCode?: string }) {
  const { isAdmin } = useAuth();
  const [openTripId, setOpenTripId] = useState<string | null>(null);

  const tripsQuery = useQuery<TripRow[]>({
    queryKey: ['service-area-trips', serviceAreaId],
    enabled: !!serviceAreaId,
    queryFn: async () => {
      const { data: trips, error } = await supabase
        .from('trips')
        .select('id, trip_number, trip_code, status, payment_status, payment_method, created_at')
        .eq('service_area_id', serviceAreaId)
        .order('created_at', { ascending: false })
        .limit(100);
      if (error) throw error;
      return trips ?? [];
    },
  });

  const openTrip = useMemo(
    () => tripsQuery.data?.find((trip) => trip.id === openTripId) ?? null,
    [openTripId, tripsQuery.data],
  );

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
        <CardTitle className="text-base">Recent trips — payment status</CardTitle>
        <p className="text-xs text-muted-foreground">
          Latest 100 trips in this service area. Trip financial values and recovery actions live in Financial Reconciliation → Trips (SSOT).
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
                  <TableHead>Financial Reconciliation</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tripsQuery.data.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell className="font-mono text-xs">{getTripDisplayId(t)}</TableCell>
                    <TableCell className="text-xs">{format(new Date(t.created_at), 'dd MMM HH:mm')}</TableCell>
                    <TableCell className="text-xs capitalize">{t.payment_method || '—'}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-xs">{t.payment_status || '—'}</Badge>
                    </TableCell>
                    <TableCell>
                      <FinancialReconciliationTripLink
                        tripId={t.id}
                        tripCode={t.trip_code}
                        tripNumber={t.trip_number}
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <Button size="sm" variant="outline" onClick={() => setOpenTripId(t.id)}>
                        View
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>

      <Dialog open={!!openTripId} onOpenChange={(o) => !o && setOpenTripId(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Trip payment status</DialogTitle>
          </DialogHeader>
          {openTrip && (
            <div className="space-y-4 text-sm">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <p className="text-xs text-muted-foreground">Trip</p>
                  <p className="font-mono font-medium">{getTripDisplayId(openTrip)}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Status</p>
                  <p className="capitalize">{openTrip.status}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Payment method</p>
                  <p className="capitalize">{openTrip.payment_method || '—'}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Payment status</p>
                  <Badge variant="outline">{openTrip.payment_status || '—'}</Badge>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Fare, commission, capture, and recovery actions are only in Financial Reconciliation → Trips.
              </p>
              <div className="flex flex-wrap gap-2">
                <FinancialReconciliationTripLink
                  tripId={openTrip.id}
                  tripCode={openTrip.trip_code}
                  tripNumber={openTrip.trip_number}
                  variant="button"
                />
                <Button asChild size="sm" variant="default">
                  <Link to={financeReconciliationTripUrl(openTrip.id, openTrip.trip_code ?? openTrip.trip_number)}>
                    <Calculator className="h-4 w-4 mr-1" />
                    Open recovery
                  </Link>
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
