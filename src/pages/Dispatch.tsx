import { useEffect, useState } from 'react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { supabase } from '@/integrations/supabase/client';
import { Navigation, Loader2, MapPin } from 'lucide-react';
import { format } from 'date-fns';

interface Trip {
  id: string;
  trip_code: string | null;
  pickup_address: string;
  dropoff_address: string;
  status: string | null;
  fare: number | null;
  estimated_fare: number | null;
  passenger_name: string | null;
  created_at: string;
  driver?: {
    first_name: string;
    last_name: string;
    driver_code: string | null;
  } | null;
}

export default function Dispatch() {
  const [trips, setTrips] = useState<Trip[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchTrips() {
      try {
        const { data, error } = await supabase
          .from('trips')
          .select(`
            *,
            driver:drivers(first_name, last_name, driver_code)
          `)
          .order('created_at', { ascending: false })
          .limit(50);

        if (error) {
          throw error;
        }

        setTrips(data || []);
      } catch (err) {
        console.error('Error fetching trips:', err);
        setError('Failed to load trips. Please try again.');
      } finally {
        setIsLoading(false);
      }
    }

    fetchTrips();
  }, []);

  const getStatusColor = (status: string | null) => {
    switch (status) {
      case 'completed':
        return 'bg-green-500/10 text-green-600';
      case 'in_progress':
        return 'bg-blue-500/10 text-blue-600';
      case 'pending':
        return 'bg-yellow-500/10 text-yellow-600';
      case 'cancelled':
        return 'bg-red-500/10 text-red-600';
      default:
        return 'bg-gray-500/10 text-gray-600';
    }
  };

  return (
    <AdminLayout 
      title="Dispatch" 
      description="View and manage trip dispatching"
    >
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Navigation className="h-5 w-5 text-primary" />
            Recent Trips
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
            </div>
          ) : error ? (
            <div className="py-8 text-center text-destructive">{error}</div>
          ) : trips.length === 0 ? (
            <div className="py-8 text-center text-muted-foreground">
              No trips found.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Trip ID</TableHead>
                  <TableHead>Passenger</TableHead>
                  <TableHead>Route</TableHead>
                  <TableHead>Driver</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Fare</TableHead>
                  <TableHead>Date</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {trips.map((trip) => (
                  <TableRow key={trip.id}>
                    <TableCell>
                      <div className="font-mono text-sm font-medium text-primary">
                        {trip.trip_code || trip.id.slice(0, 8)}
                      </div>
                    </TableCell>
                    <TableCell className="font-medium">
                      {trip.passenger_name || 'Unknown'}
                    </TableCell>
                    <TableCell>
                      <div className="space-y-1">
                        <div className="flex items-center gap-1 text-sm">
                          <MapPin className="h-3 w-3 text-green-500" />
                          <span className="truncate max-w-[200px]">{trip.pickup_address}</span>
                        </div>
                        <div className="flex items-center gap-1 text-sm text-muted-foreground">
                          <MapPin className="h-3 w-3 text-red-500" />
                          <span className="truncate max-w-[200px]">{trip.dropoff_address}</span>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {trip.driver ? (
                        <div>
                          <div className="font-medium text-foreground">
                            {trip.driver.first_name} {trip.driver.last_name}
                          </div>
                          <div className="text-xs font-mono">
                            {trip.driver.driver_code || 'N/A'}
                          </div>
                        </div>
                      ) : (
                        'Unassigned'
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="secondary"
                        className={getStatusColor(trip.status)}
                      >
                        {trip.status || 'unknown'}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      ${(trip.fare || trip.estimated_fare || 0).toFixed(2)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {format(new Date(trip.created_at), 'MMM d, HH:mm')}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </AdminLayout>
  );
}
