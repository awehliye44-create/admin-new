import { useEffect, useState } from 'react';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogFooter,
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
import { VehicleChangeReviewDialog } from '@/components/vehicles/VehicleChangeReviewDialog';
import { AdminVehicleEditDialog } from '@/components/vehicles/AdminVehicleEditDialog';
import { AdminVehicleReasonDialog } from '@/components/vehicles/AdminVehicleReasonDialog';
import { DriverSelector, driverOptionLabel, type DriverOption } from '@/components/finance/DriverSelector';
import { Textarea } from '@/components/ui/textarea';
import { supabase } from '@/integrations/supabase/client';
import { adminLookupByIds, adminPageSelect } from '@/lib/adminPageGatedData';
import {
  adminArchiveDriverVehicle,
  adminAssignSharedVehicle,
  adminListOpenVehicleAssignments,
  adminListVehicleChangeRequests,
  adminReturnSharedVehicleAssignment,
  adminSetTripActiveVehicle,
  adminSuspendDriverVehicle,
  adminVehicleDocumentComplianceSummaries,
  type OpenVehicleAssignment,
  type VehicleDocComplianceSummary,
  type VehicleChangeRequestRow,
} from '@/lib/vehicleLifecycleAdmin';
import { Plus, CarTaxiFront, Loader2, ArrowRight, AlertTriangle, Clock, Archive } from 'lucide-react';
import { toast } from 'sonner';

interface Vehicle {
  id: string;
  make: string;
  model: string;
  year: number;
  color: string;
  license_plate: string;
  is_primary: boolean;
  is_trip_active?: boolean | null;
  operational_status?: string | null;
  capacity?: number | null;
  vehicle_type_id?: string | null;
  approval_status?: string | null;
  rejection_reason?: string | null;
  driver_id?: string | null;
  driver?: {
    first_name: string;
    last_name: string;
    driver_code: string | null;
    driver_status: string | null;
    deleted_at: string | null;
  } | null;
}

/** Soft-deleted driver vehicles stay in Archived; operational archived/fleet pool too. */
const isArchivedVehicle = (vehicle: Vehicle) =>
  Boolean(vehicle.driver?.deleted_at) ||
  vehicle.driver?.driver_status === 'deleted' ||
  vehicle.operational_status === 'archived';

const isFleetAvailable = (vehicle: Vehicle) =>
  vehicle.operational_status === 'available_in_fleet';

function vehicleStatusBadge(vehicle: Vehicle) {
  if (vehicle.operational_status === 'suspended_under_repair') {
    return (
      <Badge variant="outline" className="bg-red-100 text-red-700 border-red-200">
        Suspended — Under repair
      </Badge>
    );
  }
  if (vehicle.operational_status === 'available_in_fleet') {
    return (
      <Badge variant="outline" className="bg-blue-100 text-blue-700 border-blue-200">
        Available in fleet
      </Badge>
    );
  }
  if (vehicle.approval_status === 'pending') {
    return (
      <Badge variant="outline" className="bg-yellow-100 text-yellow-700 border-yellow-200">
        Pending review
      </Badge>
    );
  }
  if (vehicle.is_trip_active && vehicle.approval_status === 'approved') {
    return (
      <Badge className="bg-green-100 text-green-700 border-green-200" variant="outline">
        Active
      </Badge>
    );
  }
  if (vehicle.is_primary) {
    return (
      <Badge variant="outline" className="bg-primary/10 text-primary">
        Primary
      </Badge>
    );
  }
  return <Badge variant="secondary">Saved</Badge>;
}

const displayPlate = (plate: string) =>
  plate?.startsWith('DELETED-') ? 'Released' : plate;

type VehicleChangeRequest = VehicleChangeRequestRow;

function complianceBadge(summary: VehicleDocComplianceSummary | undefined) {
  if (!summary) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  const tone =
    summary.summary === 'complete'
      ? 'bg-green-100 text-green-700 border-green-200'
      : summary.summary === 'pending_review'
        ? 'bg-yellow-100 text-yellow-700 border-yellow-200'
        : summary.summary === 'action_needed' || summary.summary === 'expired' || summary.summary === 'missing'
          ? 'bg-red-100 text-red-700 border-red-200'
          : 'bg-zinc-100 text-zinc-700 border-zinc-200';
  return (
    <Badge variant="outline" className={tone} title={summary.label}>
      {summary.label}
    </Badge>
  );
}

export default function Vehicles() {
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [changeRequests, setChangeRequests] = useState<VehicleChangeRequest[]>([]);
  const [complianceByVehicle, setComplianceByVehicle] = useState<
    Map<string, VehicleDocComplianceSummary>
  >(new Map());
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingRequests, setIsLoadingRequests] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Review dialog state
  const [reviewRequest, setReviewRequest] = useState<VehicleChangeRequest | null>(null);
  const [editingVehicle, setEditingVehicle] = useState<Vehicle | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [openAssignments, setOpenAssignments] = useState<OpenVehicleAssignment[]>([]);
  const [assignTarget, setAssignTarget] = useState<Vehicle | null>(null);
  const [assignDriverId, setAssignDriverId] = useState<string | null>(null);
  const [assignDriver, setAssignDriver] = useState<DriverOption | null>(null);
  const [assignBusy, setAssignBusy] = useState(false);
  const [assignReason, setAssignReason] = useState('');
  const [returnBusyId, setReturnBusyId] = useState<string | null>(null);
  const [reasonAction, setReasonAction] = useState<{
    kind: 'suspend' | 'set_active' | 'archive' | 'return';
    vehicle: Vehicle;
    assignmentId?: string;
  } | null>(null);
  const [reasonBusy, setReasonBusy] = useState(false);

  const fetchVehicles = async () => {
    try {
      // Page-authorized read via admin_page_select — never a direct table select.
      const { rows } = await adminPageSelect<{
        id: string;
        make: string;
        model: string;
        year: number;
        color: string;
        license_plate: string;
        is_primary: boolean;
        is_trip_active: boolean | null;
        operational_status: string | null;
        approval_status: string | null;
        rejection_reason: string | null;
        capacity: number | null;
        vehicle_type_id: string | null;
        driver_id: string | null;
        created_at: string;
        updated_at: string;
      }>('vehicles', 'vehicles', {
        columns: [
          'id', 'make', 'model', 'year', 'color', 'license_plate', 'is_primary',
          'is_trip_active', 'operational_status', 'approval_status', 'rejection_reason',
          'capacity', 'vehicle_type_id', 'driver_id', 'created_at', 'updated_at',
        ],
        order: [{ col: 'created_at', asc: false }],
        limit: 500,
      });

      const driverIds = rows
        .map((r) => r.driver_id)
        .filter((id): id is string => Boolean(id));
      const drivers = await adminLookupByIds<{
        id: string;
        first_name: string;
        last_name: string;
        driver_code: string | null;
        driver_status: string | null;
        deleted_at: string | null;
      }>('vehicles', 'drivers', driverIds, [
        'id', 'first_name', 'last_name', 'driver_code', 'driver_status', 'deleted_at',
      ]);
      const driverById = new Map(drivers.map((d) => [d.id, d]));

      const hydrated: Vehicle[] = rows.map((r) => ({
        ...r,
        driver: r.driver_id ? driverById.get(r.driver_id) ?? null : null,
      }));
      setVehicles(hydrated);

      try {
        const summaries = await adminVehicleDocumentComplianceSummaries(
          hydrated.map((v) => v.id),
        );
        setComplianceByVehicle(summaries);
      } catch (complianceErr) {
        console.error('Error fetching vehicle document compliance:', complianceErr);
        setComplianceByVehicle(new Map());
      }
    } catch (err) {
      console.error('Error fetching vehicles:', err);
      setError('Failed to load vehicles. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const fetchChangeRequests = async () => {
    try {
      setChangeRequests(await adminListVehicleChangeRequests(200));
    } catch (err) {
      console.error('Error fetching change requests:', err);
      toast.error('Failed to load vehicle change requests. Refresh the page or check Vehicles page access.');
      setChangeRequests([]);
    } finally {
      setIsLoadingRequests(false);
    }
  };

  const fetchOpenAssignments = async () => {
    try {
      setOpenAssignments(await adminListOpenVehicleAssignments());
    } catch {
      setOpenAssignments([]);
    }
  };

  useEffect(() => {
    fetchVehicles();
    fetchChangeRequests();
    void fetchOpenAssignments();
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

  const activeVehicles = vehicles.filter(
    (v) => !isArchivedVehicle(v) && !isFleetAvailable(v),
  );
  const fleetVehicles = vehicles.filter((v) => isFleetAvailable(v) && !isArchivedVehicle(v));
  const archivedVehicles = vehicles.filter(isArchivedVehicle);
  const visibleVehicles = showArchived
    ? archivedVehicles
    : [...activeVehicles, ...fleetVehicles];

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

        {openAssignments.length > 0 && (
          <Card className="border-blue-500/30 bg-blue-500/5">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-blue-700">
                Open shared assignments
                <Badge variant="secondary">{openAssignments.length}</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Driver</TableHead>
                    <TableHead>Vehicle</TableHead>
                    <TableHead>Started</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {openAssignments.map((asg) => (
                    <TableRow key={asg.id}>
                      <TableCell>
                        {asg.driver_first_name} {asg.driver_last_name}
                      </TableCell>
                      <TableCell>
                        {[asg.year, asg.make, asg.model].filter(Boolean).join(' ')}
                        <div className="text-xs text-muted-foreground">{asg.licence_plate}</div>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {new Date(asg.started_at).toLocaleDateString()}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={returnBusyId === asg.id}
                          onClick={() => {
                            const vehicle =
                              vehicles.find((v) => v.id === asg.vehicle_id) ??
                              ({
                                id: asg.vehicle_id,
                                make: asg.make ?? '',
                                model: asg.model ?? '',
                                year: asg.year ?? 0,
                                color: '',
                                license_plate: asg.licence_plate ?? '',
                                is_primary: false,
                              } satisfies Vehicle);
                            setReasonAction({
                              kind: 'return',
                              vehicle,
                              assignmentId: asg.id,
                            });
                          }}
                        >
                          {returnBusyId === asg.id ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            'Return to fleet'
                          )}
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
              <Button
                variant="outline"
                onClick={() =>
                  toast.message('Add a vehicle from Drivers → open the driver → Vehicles tab.')
                }
              >
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
                    <TableHead>Status</TableHead>
                    <TableHead>Documents</TableHead>
                    <TableHead>Assignment</TableHead>
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
                          <Badge variant="secondary">Archived — history retained</Badge>
                        ) : (
                          <div className="flex flex-col gap-1 items-start">
                            {vehicleStatusBadge(vehicle)}
                            {vehicle.is_primary &&
                            vehicle.operational_status !== 'suspended_under_repair' ? (
                              <span className="text-[10px] text-muted-foreground">Primary choice</span>
                            ) : null}
                            {vehicle.approval_status === 'rejected' ? (
                              <span className="text-[10px] text-destructive">Rejected</span>
                            ) : null}
                          </div>
                        )}
                      </TableCell>
                      <TableCell>
                        {showArchived
                          ? (
                            <span className="text-xs text-muted-foreground">History retained</span>
                          )
                          : complianceBadge(complianceByVehicle.get(vehicle.id))}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {openAssignments.some((a) => a.vehicle_id === vehicle.id)
                          ? 'Shared assignment open'
                          : isFleetAvailable(vehicle)
                            ? 'Fleet pool'
                            : vehicle.driver_id
                              ? 'Driver-owned'
                              : 'Unassigned'}
                      </TableCell>
                      <TableCell className="text-right">
                        {showArchived ? (
                          <span className="text-xs text-muted-foreground">
                            Archived — removed from active use
                          </span>
                        ) : (
                          <div className="flex justify-end flex-wrap gap-2">
                            {isFleetAvailable(vehicle) ? (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => {
                                  setAssignTarget(vehicle);
                                  setAssignDriverId(null);
                                  setAssignDriver(null);
                                  setAssignReason('');
                                }}
                              >
                                Assign to driver
                              </Button>
                            ) : null}
                            {openAssignments.some((a) => a.vehicle_id === vehicle.id) ? (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => {
                                  const asg = openAssignments.find((a) => a.vehicle_id === vehicle.id);
                                  if (!asg) return;
                                  setReasonAction({
                                    kind: 'return',
                                    vehicle,
                                    assignmentId: asg.id,
                                  });
                                }}
                              >
                                Return to fleet
                              </Button>
                            ) : null}
                            {vehicle.driver_id &&
                            vehicle.approval_status === 'approved' &&
                            vehicle.operational_status !== 'suspended_under_repair' &&
                            !vehicle.is_trip_active ? (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setReasonAction({ kind: 'set_active', vehicle })}
                              >
                                Set Active
                              </Button>
                            ) : null}
                            {vehicle.driver_id &&
                            vehicle.operational_status !== 'suspended_under_repair' &&
                            vehicle.operational_status !== 'available_in_fleet' ? (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setReasonAction({ kind: 'suspend', vehicle })}
                              >
                                Suspend
                              </Button>
                            ) : null}
                            {vehicle.driver_id &&
                            !vehicle.is_trip_active &&
                            !vehicle.is_primary &&
                            vehicle.operational_status !== 'archived' ? (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setReasonAction({ kind: 'archive', vehicle })}
                              >
                                Remove
                              </Button>
                            ) : null}
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setEditingVehicle(vehicle)}
                            >
                              Edit
                            </Button>
                          </div>
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

      <AdminVehicleEditDialog
        vehicle={editingVehicle}
        open={Boolean(editingVehicle)}
        onClose={() => setEditingVehicle(null)}
        onSaved={(updated) => {
          setVehicles((prev) =>
            prev.map((v) => (v.id === updated.id ? { ...v, ...updated, driver: v.driver } : v)),
          );
          setEditingVehicle(null);
        }}
      />

      <Dialog
        open={Boolean(assignTarget)}
        onOpenChange={(open) => {
          if (!open) setAssignTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Assign shared vehicle</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {assignTarget
              ? `${assignTarget.year} ${assignTarget.make} ${assignTarget.model} (${assignTarget.license_plate})`
              : ''}
          </p>
          <div className="space-y-2">
            <Label>Driver</Label>
            <DriverSelector
              pageSlug="vehicles"
              value={assignDriverId}
              onChange={(id, driver) => {
                setAssignDriverId(id);
                setAssignDriver(driver ?? null);
              }}
            />
            {assignDriver ? (
              <p className="text-xs text-muted-foreground">
                Selected: {driverOptionLabel(assignDriver)}
              </p>
            ) : null}
            <div className="space-y-2">
              <Label htmlFor="assign-reason">Reason</Label>
              <Textarea
                id="assign-reason"
                value={assignReason}
                onChange={(e) => setAssignReason(e.target.value)}
                rows={2}
                placeholder="Required — why this temporary assignment"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Suspends the driver’s current Active vehicle (under repair) and assigns this fleet
              vehicle as trip-active. Eligibility and assignment conflicts are enforced by the
              server. Documents stay on their own vehicle ids — driver-private docs are never
              exposed to the next assignee.
            </p>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setAssignTarget(null);
                setAssignDriverId(null);
                setAssignDriver(null);
                setAssignReason('');
              }}
              disabled={assignBusy}
            >
              Cancel
            </Button>
            <Button
              disabled={
                assignBusy || !assignTarget || !assignDriverId || !assignReason.trim()
              }
              onClick={() => {
                if (!assignTarget || !assignDriverId || !assignReason.trim()) return;
                setAssignBusy(true);
                void adminAssignSharedVehicle({
                  vehicleId: assignTarget.id,
                  driverId: assignDriverId,
                  suspendPrevious: true,
                  reason: assignReason.trim(),
                })
                  .then((result) => {
                    if (result.ok) {
                      toast.success(
                        assignDriver
                          ? `Assigned to ${driverOptionLabel(assignDriver)}`
                          : 'Shared vehicle assigned',
                      );
                      setAssignTarget(null);
                      setAssignDriverId(null);
                      setAssignDriver(null);
                      setAssignReason('');
                      void fetchVehicles();
                      void fetchOpenAssignments();
                    } else {
                      toast.error(result.message);
                    }
                  })
                  .finally(() => setAssignBusy(false));
              }}
            >
              {assignBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Assign'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AdminVehicleReasonDialog
        open={Boolean(reasonAction)}
        title={
          reasonAction?.kind === 'suspend'
            ? 'Suspend vehicle?'
            : reasonAction?.kind === 'set_active'
              ? 'Set Active trip vehicle?'
              : reasonAction?.kind === 'archive'
                ? 'Remove vehicle from active use?'
                : 'Return shared vehicle to fleet?'
        }
        description={
          reasonAction?.kind === 'suspend'
            ? 'Marks the vehicle suspended under repair and clears Active. Documents stay on this vehicle.'
            : reasonAction?.kind === 'set_active'
              ? 'Makes this the driver’s Active trip vehicle. Other trip-active flags are cleared. Documents are not moved.'
              : reasonAction?.kind === 'archive'
                ? 'Archives the vehicle (removed from active use). Historical trips, assignments and documents are preserved — nothing is cascade-deleted.'
                : 'Ends the shared assignment and returns the asset to the fleet pool. Driver-private documents stay private.'
        }
        confirmLabel={
          reasonAction?.kind === 'suspend'
            ? 'Suspend'
            : reasonAction?.kind === 'set_active'
              ? 'Set Active'
              : reasonAction?.kind === 'archive'
                ? 'Archive'
                : 'Return to fleet'
        }
        destructive={reasonAction?.kind === 'archive' || reasonAction?.kind === 'suspend'}
        busy={reasonBusy}
        onClose={() => {
          if (!reasonBusy) setReasonAction(null);
        }}
        onConfirm={(reason) => {
          if (!reasonAction) return;
          setReasonBusy(true);
          const run =
            reasonAction.kind === 'suspend'
              ? adminSuspendDriverVehicle(reasonAction.vehicle.id, reason)
              : reasonAction.kind === 'set_active'
                ? adminSetTripActiveVehicle(reasonAction.vehicle.id, reason)
                : reasonAction.kind === 'archive'
                  ? adminArchiveDriverVehicle(reasonAction.vehicle.id, reason)
                  : adminReturnSharedVehicleAssignment(
                      reasonAction.assignmentId ?? '',
                      reason,
                    );
          void run
            .then((result) => {
              if (result.ok) {
                const label =
                  reasonAction.kind === 'suspend'
                    ? 'Vehicle suspended'
                    : reasonAction.kind === 'set_active'
                      ? 'Active vehicle updated'
                      : reasonAction.kind === 'archive'
                        ? 'Vehicle archived — history retained'
                        : 'Vehicle returned to fleet';
                toast.success(label);
                setReasonAction(null);
                void fetchVehicles();
                void fetchOpenAssignments();
              } else {
                toast.error(result.message);
              }
            })
            .finally(() => setReasonBusy(false));
        }}
      />
    </AdminLayout>
  );
}
