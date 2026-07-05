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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Loader2 } from 'lucide-react';
import { ROLE_LABELS, StaffRole } from '@/hooks/useStaffProfile';
import { DAY_OF_WEEK_LABELS, INTERNAL_STAFF_ROLES } from '@/lib/staffWorkPatternsModel';

export interface CoverageRequirementFormValues {
  shift_name: string;
  staff_role: StaffRole;
  day_of_week: number;
  start_time: string;
  end_time: string;
  required_staff_count: number;
  region_id: string | null;
  service_area_id: string | null;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  regions: { id: string; name: string }[];
  serviceAreas: { id: string; name: string; region_id: string | null }[];
  onSubmit: (values: CoverageRequirementFormValues) => Promise<void>;
}

const defaultValues: CoverageRequirementFormValues = {
  shift_name: 'Day shift',
  staff_role: 'operator',
  day_of_week: 0,
  start_time: '08:00',
  end_time: '16:00',
  required_staff_count: 2,
  region_id: null,
  service_area_id: null,
};

export function StaffCoverageRequirementDialog({
  open,
  onOpenChange,
  regions,
  serviceAreas,
  onSubmit,
}: Props) {
  const [values, setValues] = useState<CoverageRequirementFormValues>(defaultValues);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (open) setValues(defaultValues);
  }, [open]);

  const filteredAreas = values.region_id
    ? serviceAreas.filter((area) => area.region_id === values.region_id)
    : serviceAreas;

  const handleSubmit = async () => {
    setIsSubmitting(true);
    try {
      await onSubmit(values);
      onOpenChange(false);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add coverage requirement</DialogTitle>
          <DialogDescription>
            Define how many staff are required for a shift. Gaps appear when scheduled assigned
            patterns fall below required count.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="shift-name">Shift name</Label>
            <Input
              id="shift-name"
              value={values.shift_name}
              onChange={(event) =>
                setValues((current) => ({ ...current, shift_name: event.target.value }))
              }
            />
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label>Role</Label>
              <Select
                value={values.staff_role}
                onValueChange={(value: StaffRole) =>
                  setValues((current) => ({ ...current, staff_role: value }))
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {INTERNAL_STAFF_ROLES.map((role) => (
                    <SelectItem key={role} value={role}>
                      {ROLE_LABELS[role]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Day</Label>
              <Select
                value={String(values.day_of_week)}
                onValueChange={(value) =>
                  setValues((current) => ({ ...current, day_of_week: Number(value) }))
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DAY_OF_WEEK_LABELS.map((label, index) => (
                    <SelectItem key={label} value={String(index)}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="req-start">Start time</Label>
              <Input
                id="req-start"
                type="time"
                value={values.start_time}
                onChange={(event) =>
                  setValues((current) => ({ ...current, start_time: event.target.value }))
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="req-end">End time</Label>
              <Input
                id="req-end"
                type="time"
                value={values.end_time}
                onChange={(event) =>
                  setValues((current) => ({ ...current, end_time: event.target.value }))
                }
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="required-count">Required staff count</Label>
            <Input
              id="required-count"
              type="number"
              min={1}
              value={values.required_staff_count}
              onChange={(event) =>
                setValues((current) => ({
                  ...current,
                  required_staff_count: Math.max(1, Number(event.target.value) || 1),
                }))
              }
            />
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label>Region</Label>
              <Select
                value={values.region_id ?? 'all'}
                onValueChange={(value) =>
                  setValues((current) => ({
                    ...current,
                    region_id: value === 'all' ? null : value,
                    service_area_id: null,
                  }))
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="All regions" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All regions</SelectItem>
                  {regions.map((region) => (
                    <SelectItem key={region.id} value={region.id}>
                      {region.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Service area</Label>
              <Select
                value={values.service_area_id ?? 'all'}
                onValueChange={(value) =>
                  setValues((current) => ({
                    ...current,
                    service_area_id: value === 'all' ? null : value,
                  }))
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="All areas" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All areas</SelectItem>
                  {filteredAreas.map((area) => (
                    <SelectItem key={area.id} value={area.id}>
                      {area.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!values.shift_name.trim() || isSubmitting}>
            {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Add requirement
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
