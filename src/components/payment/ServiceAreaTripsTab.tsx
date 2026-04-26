import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/hooks/useAuth';
import { PaymentControlsCard } from '@/components/payment/PaymentControlsCard';
import { format } from 'date-fns';
import { getTripDisplayId } from '@/lib/tripUtils';
import { Banknote, Undo2, Pencil, ShieldAlert } from 'lucide-react';

interface TripRow {
  id: string;
  trip_number: string | null;
  trip_code: string | null;
  status: string;
  payment_status: string | null;
  payment_method: string | null;
  gross_fare_pence: number | null;
  final_fare_pence: number | null;
  created_at: string;
}

export function ServiceAreaTripsTab({ serviceAreaId, currencyCode = 'GBP' }: { serviceAreaId: string; currencyCode?: string }) {
  const { isAdmin } = useAuth();
  const [openTripId, setOpenTripId] = useState<string | null>(null);

  const tripsQuery = useQuery<TripRow[]>({
    queryKey: ['service-area-trips', serviceAreaId],
    enabled: !!serviceAreaId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('trips')
        .select('id, trip_number, trip_code, status, payment_status, payment_method, gross_fare_pence, final_fare_pence, created_at')
        .eq('service_area_id', serviceAreaId)
        .order('created_at', { ascending: false })
        .limit(100);
      if (error) throw error;
      return (data || []) as TripRow[];
    },
  });

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

  const formatPence = (pence: number | null) => {
    const value = (pence || 0) / 100;
    try { return new Intl.NumberFormat('en-GB', { style: 'currency', currency: currencyCode }).format(value); }
    catch { return `${value.toFixed(2)} ${currencyCode}`; }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Recent trips — payment controls</CardTitle>
        <p className="text-xs text-muted-foreground">
          Latest 100 trips in this service area. Use Capture / Refund / Edit Fare to manage Stripe payments.
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
                  <TableHead className="text-right">Fare</TableHead>
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
                    <TableCell className="text-right text-xs">{formatPence(t.final_fare_pence ?? t.gross_fare_pence)}</TableCell>
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
          {openTripId && <PaymentControlsCard tripId={openTripId} />}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
