import { useEffect, useMemo, useState } from 'react';
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
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Loader2 } from 'lucide-react';
import { ROLE_LABELS, StaffRole } from '@/hooks/useStaffProfile';
import {
  applyShiftLengthPreset,
  buildDefaultSchedule,
  calculateDailyMinutes,
  calculateWeeklyMinutes,
  DaySchedule,
  formatMinutesAsHours,
  ShiftLengthPreset,
  summarizeWorkingDays,
  WEEKDAY_KEYS,
  WEEKDAY_LABELS,
} from '../../../shared/staffWorkPatternHours';
import {
  INTERNAL_STAFF_ROLES,
  PATTERN_TYPE_LABELS,
  StaffWorkPatternRow,
  StaffWorkPatternType,
} from '@/lib/staffWorkPatternsModel';

interface RegionOption {
  id: string;
  name: string;
}

interface ServiceAreaOption {
  id: string;
  name: string;
  region_id: string | null;
}

export interface StaffPatternFormValues {
  name: string;
  pattern_type: StaffWorkPatternType;
  timezone: string;
  description: string;
  shift_length_preset: ShiftLengthPreset;
  schedule: DaySchedule[];
  staff_role: StaffRole | null;
  region_id: string | null;
  service_area_id: string | null;
  is_active: boolean;
  effective_from: string;
  effective_to: string;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pattern: StaffWorkPatternRow | null;
  regions: RegionOption[];
  serviceAreas: ServiceAreaOption[];
  onSubmit: (values: StaffPatternFormValues) => Promise<void>;
  duplicateFrom?: StaffWorkPatternRow | null;
}

const TIMEZONES = ['Europe/London', 'Europe/Dublin', 'Africa/Lagos', 'UTC'];

function toFormValues(
  pattern: StaffWorkPatternRow | null,
  duplicateFrom?: StaffWorkPatternRow | null,
): StaffPatternFormValues {
  const source = duplicateFrom ?? pattern;
  if (!source) {
    return {
      name: '',
      pattern_type: 'fixed_weekly',
      timezone: 'Europe/London',
      description: '',
      shift_length_preset: '8h',
      schedule: buildDefaultSchedule(true),
      staff_role: 'operator',
      region_id: null,
      service_area_id: null,
      is_active: true,
      effective_from: '',
      effective_to: '',
    };
  }

  return {
    name: duplicateFrom ? `${source.name} (Copy)` : source.name,
    pattern_type: source.pattern_type,
    timezone: source.timezone,
    description: source.description ?? '',
    shift_length_preset: source.shift_length_preset,
    schedule: source.schedule?.length ? source.schedule : buildDefaultSchedule(true),
    staff_role: source.staff_role,
    region_id: source.region_id,
    service_area_id: source.service_area_id,
    is_active: source.is_active,
    effective_from: source.effective_from ?? '',
    effective_to: source.effective_to ?? '',
  };
}

export function StaffWorkPatternFormDialog({
  open,
  onOpenChange,
  pattern,
  regions,
  serviceAreas,
  onSubmit,
  duplicateFrom,
}: Props) {
  const [values, setValues] = useState<StaffPatternFormValues>(() =>
    toFormValues(pattern, duplicateFrom),
  );
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setValues(toFormValues(pattern, duplicateFrom));
    }
  }, [open, pattern, duplicateFrom]);

  const filteredServiceAreas = useMemo(
    () =>
      values.region_id
        ? serviceAreas.filter((area) => area.region_id === values.region_id)
        : serviceAreas,
    [serviceAreas, values.region_id],
  );

  const enabledDays = values.schedule.filter((day) => day.enabled);
  const sampleDay = enabledDays[0];
  const dailyMinutes = sampleDay
    ? calculateDailyMinutes(sampleDay.start_time, sampleDay.end_time, sampleDay.break_minutes)
    : 0;
  const weeklyMinutes = calculateWeeklyMinutes(values.schedule);

  const updateDay = (dayKey: string, patch: Partial<DaySchedule>) => {
    setValues((current) => ({
      ...current,
      schedule: current.schedule.map((day) =>
        day.day === dayKey ? { ...day, ...patch } : day,
      ),
      shift_length_preset: 'custom',
    }));
  };

  const handlePresetChange = (preset: ShiftLengthPreset) => {
    setValues((current) => ({
      ...current,
      shift_length_preset: preset,
      schedule: applyShiftLengthPreset(current.schedule, preset),
    }));
  };

  const handleSubmit = async () => {
    setIsSubmitting(true);
    try {
      await onSubmit(values);
      onOpenChange(false);
    } finally {
      setIsSubmitting(false);
    }
  };

  const title = duplicateFrom
    ? 'Duplicate Work Pattern'
    : pattern
      ? 'Edit Work Pattern'
      : 'Create Work Pattern';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Define reusable shift patterns for internal ONECAB staff. Drivers are not managed here.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-6 md:grid-cols-[2fr_1fr]">
          <div className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="pattern-name">Pattern name</Label>
                <Input
                  id="pattern-name"
                  value={values.name}
                  onChange={(event) =>
                    setValues((current) => ({ ...current, name: event.target.value }))
                  }
                  placeholder="Mon - Fri (Day)"
                />
              </div>
              <div className="space-y-2">
                <Label>Pattern type</Label>
                <Select
                  value={values.pattern_type}
                  onValueChange={(value: StaffWorkPatternType) =>
                    setValues((current) => ({ ...current, pattern_type: value }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(PATTERN_TYPE_LABELS).map(([key, label]) => (
                      <SelectItem key={key} value={key}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Shift length</Label>
                <Select
                  value={values.shift_length_preset}
                  onValueChange={(value: ShiftLengthPreset) => handlePresetChange(value)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="8h">8-hour (08:00–16:00)</SelectItem>
                    <SelectItem value="10h">10-hour (08:00–18:00)</SelectItem>
                    <SelectItem value="12h">12-hour (07:00–19:00)</SelectItem>
                    <SelectItem value="night_12h">Night 12-hour (19:00–07:00)</SelectItem>
                    <SelectItem value="custom">Custom shift</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Timezone</Label>
                <Select
                  value={values.timezone}
                  onValueChange={(timezone) =>
                    setValues((current) => ({ ...current, timezone }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TIMEZONES.map((timezone) => (
                      <SelectItem key={timezone} value={timezone}>
                        {timezone}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Role</Label>
                <Select
                  value={values.staff_role ?? 'none'}
                  onValueChange={(value) =>
                    setValues((current) => ({
                      ...current,
                      staff_role: value === 'none' ? null : (value as StaffRole),
                    }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Any role" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Any role</SelectItem>
                    {INTERNAL_STAFF_ROLES.map((role) => (
                      <SelectItem key={role} value={role}>
                        {ROLE_LABELS[role]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
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
                    {filteredServiceAreas.map((area) => (
                      <SelectItem key={area.id} value={area.id}>
                        {area.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="pattern-description">Description</Label>
              <Textarea
                id="pattern-description"
                value={values.description}
                onChange={(event) =>
                  setValues((current) => ({ ...current, description: event.target.value }))
                }
                rows={2}
              />
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="effective-from">Effective from</Label>
                <Input
                  id="effective-from"
                  type="date"
                  value={values.effective_from}
                  onChange={(event) =>
                    setValues((current) => ({ ...current, effective_from: event.target.value }))
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="effective-to">Effective to</Label>
                <Input
                  id="effective-to"
                  type="date"
                  value={values.effective_to}
                  onChange={(event) =>
                    setValues((current) => ({ ...current, effective_to: event.target.value }))
                  }
                />
              </div>
            </div>

            <div className="flex items-center justify-between rounded-lg border p-3">
              <div>
                <p className="font-medium">Active pattern</p>
                <p className="text-sm text-muted-foreground">
                  Inactive patterns are archived from scheduling and coverage.
                </p>
              </div>
              <Switch
                checked={values.is_active}
                onCheckedChange={(checked) =>
                  setValues((current) => ({ ...current, is_active: checked }))
                }
              />
            </div>

            <div className="space-y-3">
              <Label>Working days &amp; shift</Label>
              {WEEKDAY_KEYS.map((dayKey) => {
                const day = values.schedule.find((entry) => entry.day === dayKey)!;
                return (
                  <div
                    key={dayKey}
                    className="grid gap-2 rounded-lg border p-3 md:grid-cols-[auto_1fr_1fr_1fr_1fr]"
                  >
                    <div className="flex items-center gap-2">
                      <Checkbox
                        checked={day.enabled}
                        onCheckedChange={(checked) =>
                          updateDay(dayKey, { enabled: checked === true })
                        }
                      />
                      <span className="w-10 font-medium">{WEEKDAY_LABELS[dayKey]}</span>
                    </div>
                    <Input
                      type="time"
                      value={day.start_time}
                      disabled={!day.enabled}
                      onChange={(event) => updateDay(dayKey, { start_time: event.target.value })}
                    />
                    <Input
                      type="time"
                      value={day.end_time}
                      disabled={!day.enabled}
                      onChange={(event) => updateDay(dayKey, { end_time: event.target.value })}
                    />
                    <Input
                      type="number"
                      min={0}
                      disabled={!day.enabled}
                      value={day.break_minutes}
                      onChange={(event) =>
                        updateDay(dayKey, { break_minutes: Number(event.target.value) || 0 })
                      }
                      placeholder="Break (min)"
                    />
                    <Select
                      value={day.shift_type}
                      disabled={!day.enabled}
                      onValueChange={(value) =>
                        updateDay(dayKey, { shift_type: value as DaySchedule['shift_type'] })
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="morning">Morning</SelectItem>
                        <SelectItem value="day">Day</SelectItem>
                        <SelectItem value="late">Late</SelectItem>
                        <SelectItem value="night">Night</SelectItem>
                        <SelectItem value="off">Off</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="space-y-4">
            <div className="rounded-lg border bg-muted/30 p-4 space-y-3">
              <p className="font-semibold">Pattern preview</p>
              {enabledDays.length === 0 ? (
                <p className="text-sm text-muted-foreground">No working days selected.</p>
              ) : (
                enabledDays.map((day) => (
                  <div key={day.day} className="text-sm">
                    <Badge variant="outline" className="mr-2">
                      {WEEKDAY_LABELS[day.day]}
                    </Badge>
                    {day.start_time} – {day.end_time} · {day.break_minutes}m break · {day.shift_type}
                  </div>
                ))
              )}
            </div>

            <div className="rounded-lg border p-4 space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Working days</span>
                <span>{summarizeWorkingDays(values.schedule)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Daily hours</span>
                <span>{formatMinutesAsHours(dailyMinutes)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Weekly days</span>
                <span>{enabledDays.length} days</span>
              </div>
              <div className="flex justify-between font-semibold">
                <span>Weekly hours</span>
                <span>{formatMinutesAsHours(weeklyMinutes)}</span>
              </div>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!values.name.trim() || isSubmitting}>
            {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {pattern && !duplicateFrom ? 'Save changes' : 'Create pattern'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
