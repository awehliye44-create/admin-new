import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { supabase } from '@/integrations/supabase/client';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';

export type AdminEditableVehicle = {
  id: string;
  make: string;
  model: string;
  year: number;
  color: string;
  license_plate: string;
  is_primary: boolean;
  capacity?: number | null;
  vehicle_type_id?: string | null;
  approval_status?: string | null;
  driver?: {
    first_name: string;
    last_name: string;
    driver_code: string | null;
  } | null;
};

type Props = {
  vehicle: AdminEditableVehicle | null;
  open: boolean;
  onClose: () => void;
  onSaved: (vehicle: AdminEditableVehicle) => void;
};

type VehicleTypeOption = { id: string; name: string };

export function AdminVehicleEditDialog({ vehicle, open, onClose, onSaved }: Props) {
  const [saving, setSaving] = useState(false);
  const [vehicleTypes, setVehicleTypes] = useState<VehicleTypeOption[]>([]);
  const [form, setForm] = useState({
    make: '',
    model: '',
    year: '',
    color: '',
    license_plate: '',
    capacity: '',
    vehicle_type_id: '',
    approval_status: 'pending',
    is_primary: false,
  });

  useEffect(() => {
    if (!open || !vehicle) return;
    setForm({
      make: vehicle.make ?? '',
      model: vehicle.model ?? '',
      year: String(vehicle.year ?? ''),
      color: vehicle.color ?? '',
      license_plate: vehicle.license_plate ?? '',
      capacity: String(vehicle.capacity ?? 4),
      vehicle_type_id: vehicle.vehicle_type_id ?? '',
      approval_status: vehicle.approval_status ?? 'pending',
      is_primary: Boolean(vehicle.is_primary),
    });
  }, [open, vehicle]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from('vehicle_types')
        .select('id, name')
        .eq('is_active', true)
        .order('display_order', { ascending: true });
      if (!cancelled) setVehicleTypes((data as VehicleTypeOption[]) ?? []);
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const driverLabel = vehicle?.driver
    ? `${vehicle.driver.first_name} ${vehicle.driver.last_name}`.trim() +
      (vehicle.driver.driver_code ? ` (${vehicle.driver.driver_code})` : '')
    : 'Unassigned';

  const handleSave = async () => {
    if (!vehicle) return;
    const year = parseInt(form.year, 10);
    const capacity = parseInt(form.capacity, 10);
    if (!form.make.trim() || !form.model.trim() || !form.license_plate.trim()) {
      toast.error('Make, model, and license plate are required');
      return;
    }
    if (!Number.isFinite(year) || year < 1980 || year > new Date().getFullYear() + 1) {
      toast.error('Enter a valid year');
      return;
    }
    if (!Number.isFinite(capacity) || capacity < 1 || capacity > 20) {
      toast.error('Enter a valid capacity');
      return;
    }

    setSaving(true);
    try {
      const patch = {
        make: form.make.trim(),
        model: form.model.trim(),
        year,
        color: form.color.trim() || 'Unknown',
        license_plate: form.license_plate.trim().toUpperCase(),
        capacity,
        is_primary: form.is_primary,
        approval_status: form.approval_status,
        vehicle_type_id: form.vehicle_type_id || null,
      };
      const { data, error } = await supabase
        .from('vehicles')
        .update(patch)
        .eq('id', vehicle.id)
        .select(
          'id, make, model, year, color, license_plate, is_primary, capacity, vehicle_type_id, approval_status',
        )
        .maybeSingle();
      if (error) throw error;
      if (!data) throw new Error('Update returned no row');
      toast.success('Vehicle updated');
      onSaved({
        ...vehicle,
        ...data,
        driver: vehicle.driver,
      });
      onClose();
    } catch (err) {
      console.error('Vehicle edit failed:', err);
      toast.error(err instanceof Error ? err.message : 'Failed to update vehicle');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit Vehicle</DialogTitle>
          <DialogDescription>
            {driverLabel ? `Driver: ${driverLabel}` : 'Update fleet vehicle details'}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="veh_make">Make</Label>
            <Input
              id="veh_make"
              value={form.make}
              onChange={(e) => setForm((f) => ({ ...f, make: e.target.value }))}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="veh_model">Model</Label>
            <Input
              id="veh_model"
              value={form.model}
              onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="veh_year">Year</Label>
            <Input
              id="veh_year"
              inputMode="numeric"
              value={form.year}
              onChange={(e) => setForm((f) => ({ ...f, year: e.target.value }))}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="veh_color">Color</Label>
            <Input
              id="veh_color"
              value={form.color}
              onChange={(e) => setForm((f) => ({ ...f, color: e.target.value }))}
            />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="veh_plate">License plate</Label>
            <Input
              id="veh_plate"
              value={form.license_plate}
              onChange={(e) => setForm((f) => ({ ...f, license_plate: e.target.value }))}
              className="font-mono uppercase"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="veh_capacity">Capacity</Label>
            <Input
              id="veh_capacity"
              inputMode="numeric"
              value={form.capacity}
              onChange={(e) => setForm((f) => ({ ...f, capacity: e.target.value }))}
            />
          </div>
          <div className="space-y-2">
            <Label>Category</Label>
            <Select
              value={form.vehicle_type_id || 'none'}
              onValueChange={(v) =>
                setForm((f) => ({ ...f, vehicle_type_id: v === 'none' ? '' : v }))
              }
            >
              <SelectTrigger>
                <SelectValue placeholder="Select category" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Unassigned</SelectItem>
                {vehicleTypes.map((vt) => (
                  <SelectItem key={vt.id} value={vt.id}>
                    {vt.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Approval</Label>
            <Select
              value={form.approval_status}
              onValueChange={(v) => setForm((f) => ({ ...f, approval_status: v }))}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="pending">Pending</SelectItem>
                <SelectItem value="approved">Approved</SelectItem>
                <SelectItem value="rejected">Rejected</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center justify-between rounded-md border px-3 py-2 sm:col-span-2">
            <div>
              <Label>Primary vehicle</Label>
              <p className="text-xs text-muted-foreground">Shown as the driver’s main car</p>
            </div>
            <Switch
              checked={form.is_primary}
              onCheckedChange={(checked) => setForm((f) => ({ ...f, is_primary: checked }))}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save vehicle
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
