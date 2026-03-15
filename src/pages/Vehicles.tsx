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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { supabase } from '@/integrations/supabase/client';
import { Plus, CarTaxiFront, Loader2, CheckCircle, XCircle, ArrowRight, AlertTriangle, Clock } from 'lucide-react';
import { toast } from 'sonner';

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
  };
}

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
  created_at: string;
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
  const [adminNotes, setAdminNotes] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);

  const fetchVehicles = async () => {
    try {
      const { data, error } = await supabase
        .from('vehicles')
        .select(`
          *,
          driver:drivers(first_name, last_name, driver_code)
        `)
        .order('created_at', { ascending: false });

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
          *,
          driver:drivers(first_name, last_name, driver_code),
          vehicle:vehicles(make, model, year, color, license_plate)
        `)
        .order('created_at', { ascending: false });

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

  const pendingRequests = changeRequests.filter(r => r.status === 'pending');
  const reviewedRequests = changeRequests.filter(r => r.status !== 'pending');

  const handleReview = async (approved: boolean) => {
    if (!reviewRequest) return;
    setIsProcessing(true);

    try {
      const newStatus = approved ? 'approved' : 'rejected';

      // Update the change request
      const { error: updateError } = await supabase
        .from('vehicle_change_requests')
        .update({
          status: newStatus,
          admin_notes: adminNotes || null,
          reviewed_at: new Date().toISOString(),
          reviewed_by: (await supabase.auth.getUser()).data.user?.id,
        })
        .eq('id', reviewRequest.id);

      if (updateError) throw updateError;

      // If approved, update the actual vehicle
      if (approved) {
        const { error: vehicleError } = await supabase
          .from('vehicles')
          .update({
            make: reviewRequest.requested_make,
            model: reviewRequest.requested_model,
            year: reviewRequest.requested_year,
            color: reviewRequest.requested_color,
            license_plate: reviewRequest.requested_license_plate,
          })
          .eq('id', reviewRequest.vehicle_id);

        if (vehicleError) throw vehicleError;

        // Update driver's vehicle_edit_request_status
        await supabase
          .from('drivers')
          .update({ vehicle_edit_request_status: 'approved' })
          .eq('id', reviewRequest.driver_id);

        toast.success('Vehicle change approved and applied');
        fetchVehicles();
      } else {
        await supabase
          .from('drivers')
          .update({ vehicle_edit_request_status: 'rejected' })
          .eq('id', reviewRequest.driver_id);

        toast.success('Vehicle change rejected');
      }

      setReviewRequest(null);
      setAdminNotes('');
      fetchChangeRequests();
    } catch (err) {
      console.error('Error processing request:', err);
      toast.error('Failed to process request');
    } finally {
      setIsProcessing(false);
    }
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
                          onClick={() => {
                            setReviewRequest(req);
                            setAdminNotes('');
                          }}
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

        {/* All Vehicles */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <CarTaxiFront className="h-5 w-5 text-primary" />
              All Vehicles
            </CardTitle>
            <Button>
              <Plus className="mr-2 h-4 w-4" />
              Add Vehicle
            </Button>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-primary" />
              </div>
            ) : error ? (
              <div className="py-8 text-center text-destructive">{error}</div>
            ) : vehicles.length === 0 ? (
              <div className="py-8 text-center text-muted-foreground">
                No vehicles found.
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Vehicle</TableHead>
                    <TableHead>License Plate</TableHead>
                    <TableHead>Color</TableHead>
                    <TableHead>Driver</TableHead>
                    <TableHead>Primary</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {vehicles.map((vehicle) => (
                    <TableRow key={vehicle.id}>
                      <TableCell className="font-medium">
                        {vehicle.year} {vehicle.make} {vehicle.model}
                      </TableCell>
                      <TableCell>{vehicle.license_plate}</TableCell>
                      <TableCell>{vehicle.color}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {vehicle.driver
                          ? `${vehicle.driver.first_name} ${vehicle.driver.last_name}`
                          : 'Unassigned'}
                      </TableCell>
                      <TableCell>
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
                      </TableCell>
                      <TableCell className="text-right">
                        <Button variant="ghost" size="sm">
                          Edit
                        </Button>
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
                          variant={req.status === 'approved' ? 'default' : 'destructive'}
                          className={req.status === 'approved' ? 'bg-green-500/10 text-green-600' : ''}
                        >
                          {req.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground text-sm max-w-[200px] truncate">
                        {req.admin_notes || '—'}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-sm">
                        {new Date(req.created_at).toLocaleDateString()}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Review Dialog */}
      <Dialog open={!!reviewRequest} onOpenChange={(open) => !open && setReviewRequest(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Review Vehicle Change Request</DialogTitle>
            <DialogDescription>
              {reviewRequest?.driver?.first_name} {reviewRequest?.driver?.last_name}
              {reviewRequest?.driver?.driver_code && ` (${reviewRequest.driver.driver_code})`} wants to update their vehicle.
            </DialogDescription>
          </DialogHeader>

          {reviewRequest && (
            <div className="space-y-4">
              {/* Current → Requested comparison */}
              <div className="grid grid-cols-2 gap-4">
                <div className="rounded-lg border p-3 space-y-1">
                  <p className="text-xs font-medium text-muted-foreground uppercase">Current</p>
                  {reviewRequest.vehicle ? (
                    <>
                      <p className="font-medium">{reviewRequest.vehicle.year} {reviewRequest.vehicle.make} {reviewRequest.vehicle.model}</p>
                      <p className="text-sm text-muted-foreground">{reviewRequest.vehicle.color} · {reviewRequest.vehicle.license_plate}</p>
                    </>
                  ) : (
                    <p className="text-muted-foreground">N/A</p>
                  )}
                </div>
                <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 space-y-1">
                  <p className="text-xs font-medium text-primary uppercase">Requested</p>
                  <p className="font-medium">{reviewRequest.requested_year} {reviewRequest.requested_make} {reviewRequest.requested_model}</p>
                  <p className="text-sm text-muted-foreground">{reviewRequest.requested_color} · {reviewRequest.requested_license_plate}</p>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="admin-notes">Admin Notes (optional)</Label>
                <Textarea
                  id="admin-notes"
                  placeholder="Add notes about this decision..."
                  value={adminNotes}
                  onChange={(e) => setAdminNotes(e.target.value)}
                />
              </div>
            </div>
          )}

          <DialogFooter className="flex gap-2">
            <Button
              variant="destructive"
              onClick={() => handleReview(false)}
              disabled={isProcessing}
            >
              {isProcessing ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <XCircle className="h-4 w-4 mr-2" />}
              Reject
            </Button>
            <Button
              onClick={() => handleReview(true)}
              disabled={isProcessing}
            >
              {isProcessing ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <CheckCircle className="h-4 w-4 mr-2" />}
              Approve & Apply
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AdminLayout>
  );
}
