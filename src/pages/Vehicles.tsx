import { useEffect, useState } from 'react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
import { VehicleChangeReviewDialog } from '@/components/vehicles/VehicleChangeReviewDialog';
import { supabase } from '@/integrations/supabase/client';
import { Plus, CarTaxiFront, Loader2, ArrowRight, AlertTriangle, Clock, Archive } from 'lucide-react';

interface Vehicle {
  id: string;
  make: string;
  model: string;
  year: number;
  color: string;
  license_plate: string;
  is_primary: boolean;
  driver?: {
    first_name: string;
    last_name: string;
    driver_code: string | null;
    driver_status: string | null;
    deleted_at: string | null;
  } | null;
}

/** A vehicle is archived when its driver record has been deleted. */
const isArchivedVehicle = (vehicle: Vehicle) =>
  Boolean(vehicle.driver?.deleted_at) || vehicle.driver?.driver_status === 'deleted';

const displayPlate = (plate: string) =>
  plate?.startsWith('DELETED-') ? 'Released' : plate;

interface VehicleChangeRequest {
  id: string;
  driver_id: string;
  vehicle_id: string;
  requested_make: string;
  requested_model: string;
  requested_year: number;
  requested_color: string;
  requested_license_plate: string;
  status: string;
  admin_notes: string | null;
  rejection_reason: string | null;
  created_at: string;
  reviewed_at: string | null;
  cancelled_at: string | null;
  driver?: {
    first_name: string;
    last_name: string;
    driver_code: string | null;
  };
  vehicle?: {
    make: string;
    model: string;
    year: number;
    color: string;
    license_plate: string;
  };
}

export default function Vehicles() {
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [changeRequests, setChangeRequests] = useState<VehicleChangeRequest[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingRequests, setIsLoadingRequests] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Review dialog state
  const [reviewRequest, setReviewRequest] = useState<VehicleChangeRequest | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  const fetchVehicles = async () => {
    try {
      const { data, error } = await supabase
        .from('vehicles')
        .select(`
          id, make, model, year, color, license_plate, is_primary, approval_status, rejection_reason, capacity, vehicle_type_id, driver_id, created_at, updated_at,
          driver:drivers(first_name, last_name, driver_code, driver_status, deleted_at)
        `)
        .order('created_at', { ascending: false })
        .limit(500);

      if (error) throw error;
      setVehicles(data || []);
    } catch (err) {
      console.error('Error fetching vehicles:', err);
      setError('Failed to load vehicles. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const fetchChangeRequests = async () => {
    try {
      const { data, error } = await supabase
        .from('vehicle_change_requests')
        .select(`
          id, driver_id, vehicle_id, requested_make, requested_model, requested_year, requested_color, requested_license_plate, status, admin_notes, rejection_reason, reviewed_at, reviewed_by, cancelled_at, created_at, updated_at,
          driver:drivers(first_name, last_name, driver_code),
          vehicle:vehicles(make, model, year, color, license_plate)
        `)
        .order('created_at', { ascending: false })
        .limit(200);

      if (error) throw error;
      setChangeRequests(data || []);
    } catch (err) {
      console.error('Error fetching change requests:', err);
    } finally {
      setIsLoadingRequests(false);
    }
  };

  useEffect(() => {
    fetchVehicles();
    fetchChangeRequests();
  }, []);

  // Real-time subscription for change requests
  useEffect(() => {
    const channel = supabase
      .channel('vehicle-change-requests')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'vehicle_change_requests' },
        () => fetchChangeRequests()
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const activeVehicles = vehicles.filter((v) => !isArchivedVehicle(v));
  const archivedVehicles = vehicles.filter(isArchivedVehicle);
  const visibleVehicles = showArchived ? archivedVehicles : activeVehicles;

  const pendingRequests = changeRequests.filter(r => r.status === 'pending');
  const reviewedRequests = changeRequests.filter(r => r.status !== 'pending');

  const handleDecided = (decision: 'approve' | 'reject') => {
    setReviewRequest(null);
    if (decision === 'approve') fetchVehicles();
    fetchChangeRequests();
  };

  return (
    <AdminLayout 
      title="Vehicles" 
      description="Manage fleet vehicles and change requests"
    >
      <div className="space-y-6">
        {/* Pending Vehicle Change Requests */}
        {pendingRequests.length > 0 && (
          <Card className="border-yellow-500/30 bg-yellow-500/5">
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="flex items-center gap-2 text-yellow-600">
                <AlertTriangle className="h-5 w-5" />
                Pending Vehicle Change Requests
                <Badge variant="secondary" className="bg-yellow-500/20 text-yellow-700">
                  {pendingRequests.length}
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Driver</TableHead>
                    <TableHead>Current Vehicle</TableHead>
                    <TableHead></TableHead>
                    <TableHead>Requested Vehicle</TableHead>
                    <TableHead>Submitted</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pendingRequests.map((req) => (
                    <TableRow key={req.id}>
                      <TableCell className="font-medium">
                        <div>
                          {req.driver?.first_name} {req.driver?.last_name}
                        </div>
                        {req.driver?.driver_code && (
                          <span className="text-xs text-muted-foreground">{req.driver.driver_code}</span>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {req.vehicle
                          ? `${req.vehicle.year} ${req.vehicle.make} ${req.vehicle.model} (${req.vehicle.license_plate})`
                          : '—'}
                      </TableCell>
                      <TableCell>
                        <ArrowRight className="h-4 w-4 text-muted-foreground" />
                      </TableCell>
                      <TableCell className="font-medium">
                        {req.requested_year} {req.requested_make} {req.requested_model}
                        <div className="text-xs text-muted-foreground">
                          {req.requested_color} · {req.requested_license_plate}
                        </div>
                      </TableCell>
                      <TableCell className="text-muted-foreground text-sm">
                        {new Date(req.created_at).toLocaleDateString()}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          size="sm"
                          variant="outline"
                            onClick={() => setReviewRequest(req)}
                        >
                          Review
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}

        {/* Vehicles */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <CarTaxiFront className="h-5 w-5 text-primary" />
              {showArchived ? 'Archived Vehicles' : 'Active Vehicles'}
              <Badge variant="secondary">
                {(showArchived ? archivedVehicles : activeVehicles).length}
              </Badge>
            </CardTitle>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                onClick={() => setShowArchived((prev) => !prev)}
              >
                <Archive className="mr-2 h-4 w-4" />
                {showArchived
                  ? `Show active (${activeVehicles.length})`
                  : `Archived (${archivedVehicles.length})`}
              </Button>
              <Button>
                <Plus className="mr-2 h-4 w-4" />
                Add Vehicle
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {showArchived && (
              <p className="mb-4 text-sm text-muted-foreground">
                These vehicles belonged to drivers who have been deleted. They are kept for
                record-keeping only and their number plates have been released for reuse.
              </p>
            )}
            {isLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-primary" />
              </div>
            ) : error ? (
              <div className="py-8 text-center text-destructive">{error}</div>
            ) : visibleVehicles.length === 0 ? (
              <div className="py-8 text-center text-muted-foreground">
                {showArchived ? 'No archived vehicles.' : 'No active vehicles found.'}
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Vehicle</TableHead>
                    <TableHead>License Plate</TableHead>
                    <TableHead>Color</TableHead>
                    <TableHead>Driver</TableHead>
                    <TableHead>{showArchived ? 'Status' : 'Primary'}</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleVehicles.map((vehicle) => (
                    <TableRow key={vehicle.id} className={showArchived ? 'opacity-70' : undefined}>
                      <TableCell className="font-medium">
                        {vehicle.year} {vehicle.make} {vehicle.model}
                      </TableCell>
                      <TableCell>{displayPlate(vehicle.license_plate)}</TableCell>
                      <TableCell>{vehicle.color}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {vehicle.driver
                          ? `${vehicle.driver.first_name} ${vehicle.driver.last_name}`
                          : 'Unassigned'}
                      </TableCell>
                      <TableCell>
                        {showArchived ? (
                          <Badge variant="secondary">Archived</Badge>
                        ) : (
                          <Badge
                            variant={vehicle.is_primary ? 'default' : 'secondary'}
                            className={
                              vehicle.is_primary
                                ? 'bg-primary/10 text-primary'
                                : ''
                            }
                          >
                            {vehicle.is_primary ? 'Primary' : 'Secondary'}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {showArchived ? (
                          <span className="text-xs text-muted-foreground">Read only</span>
                        ) : (
                          <Button variant="ghost" size="sm">
                            Edit
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {/* Reviewed Requests History */}
        {reviewedRequests.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm">
                <Clock className="h-4 w-4 text-muted-foreground" />
                Change Request History
              </CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Driver</TableHead>
                    <TableHead>Requested Vehicle</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Notes</TableHead>
                    <TableHead>Date</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {reviewedRequests.slice(0, 20).map((req) => (
                    <TableRow key={req.id}>
                      <TableCell>
                        {req.driver?.first_name} {req.driver?.last_name}
                        {req.driver?.driver_code && (
                          <span className="text-xs text-muted-foreground ml-1">({req.driver.driver_code})</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {req.requested_year} {req.requested_make} {req.requested_model} ({req.requested_license_plate})
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={req.status === 'rejected' ? 'destructive' : req.status === 'approved' ? 'default' : 'secondary'}
                          className={req.status === 'approved' ? 'bg-green-500/10 text-green-600' : ''}
                        >
                          {req.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground text-sm max-w-[260px]">
                        {req.rejection_reason && (
                          <div className="truncate" title={req.rejection_reason}>
                            Driver: {req.rejection_reason}
                          </div>
                        )}
                        {req.admin_notes && (
                          <div className="truncate" title={req.admin_notes}>
                            Internal: {req.admin_notes}
                          </div>
                        )}
                        {!req.rejection_reason && !req.admin_notes && '—'}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-sm">
                        {new Date(req.cancelled_at ?? req.reviewed_at ?? req.created_at).toLocaleDateString()}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}
      </div>

      <VehicleChangeReviewDialog
        requestId={reviewRequest?.id ?? null}
        driverLabel={
          reviewRequest
            ? `${reviewRequest.driver?.first_name ?? ''} ${reviewRequest.driver?.last_name ?? ''}`.trim() +
              (reviewRequest.driver?.driver_code ? ` (${reviewRequest.driver.driver_code})` : '')
            : ''
        }
        onClose={() => setReviewRequest(null)}
        onDecided={handleDecided}
      />
    </AdminLayout>
  );
}
