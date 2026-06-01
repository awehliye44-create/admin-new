import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Clock, UserX, Timer, MapPin,
  AlertTriangle, Banknote, Info
} from 'lucide-react';

interface TripLifecycleTimelineProps {
  graceMinutes: number;
  freeWaitingMinutes: number;
  waitingPerMinutePence: number;
  cancellationFeePence: number;
  noShowWaitMinutes: number;
  noShowFeePence: number;
  lateCancelEnabled: boolean;
  lateCancelThresholdMinutes: number;
  lateCancelFeePence: number;
  cancellationApplyAfterArrivalOnly: boolean;
  noShowApplyAfterArrivalOnly: boolean;
  recalculateOnWaiting: boolean;
  currencySymbol: string;
  onUpdate: (key: string, value: number | boolean) => void;
  // Stop Waiting & Get Paid (from stop_waiting_settings)
  stopRadiusEnabled: boolean;
  stopRadiusMeters: number;
  stopWaitingChargeIntervalSeconds: number;
  stopWaitingGracePeriodSeconds: number;
  stopWaitingRatePencePerMinute: number;
  stopWaitingMaxMinutes: number | null;
  onStopWaitingUpdate: (key: string, value: number | boolean | null) => void;
}

export function TripLifecycleTimeline({
  freeWaitingMinutes,
  waitingPerMinutePence,
  noShowWaitMinutes,
  noShowFeePence,
  lateCancelEnabled,
  lateCancelThresholdMinutes,
  lateCancelFeePence,
  noShowApplyAfterArrivalOnly,
  recalculateOnWaiting,
  currencySymbol,
  onUpdate,
  stopRadiusMeters,
  stopWaitingChargeIntervalSeconds,
  stopWaitingGracePeriodSeconds,
  stopWaitingRatePencePerMinute,
  onStopWaitingUpdate,
}: TripLifecycleTimelineProps) {
  const penceToDisplay = (pence: number) => (pence > 0 ? (pence / 100).toFixed(2) : '');
  const numToDisplay = (n: number) => (n > 0 ? String(n) : '');
  const displayToPence = (val: string) => Math.round(parseFloat(val || '0') * 100);

  const isEmpty = (n: number) => !n || n <= 0;

  const PenceInput = ({ value, field, label, onFieldUpdate }: { value: number; field: string; label: string; onFieldUpdate?: (key: string, value: number | boolean | null) => void }) => (
    <div className="space-y-1">
      <Label className="text-xs font-medium">
        {label} <span className="text-destructive">*</span>
      </Label>
      <div className="relative">
        <span className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground text-xs">{currencySymbol}</span>
        <Input
          type="number"
          step="0.01"
          min="0"
          placeholder="0.00"
          value={penceToDisplay(value)}
          onChange={(e) => (onFieldUpdate || onUpdate)(field, displayToPence(e.target.value))}
          className={`h-8 text-sm pl-6 w-28 ${isEmpty(value) ? 'border-destructive/50' : ''}`}
        />
      </div>
      {isEmpty(value) && <p className="text-[10px] text-destructive">Required</p>}
    </div>
  );

  const NumberInput = ({ value, field, label, unit, onFieldUpdate, min = 0 }: { value: number; field: string; label: string; unit: string; onFieldUpdate?: (key: string, value: number | boolean | null) => void; min?: number }) => (
    <div className="space-y-1">
      <Label className="text-xs font-medium">
        {label} <span className="text-destructive">*</span>
      </Label>
      <div className="relative">
        <Input
          type="number"
          min={min}
          placeholder="0"
          value={numToDisplay(value)}
          onChange={(e) => (onFieldUpdate || onUpdate)(field, parseInt(e.target.value) || 0)}
          className={`h-8 text-sm w-24 pr-10 ${isEmpty(value) ? 'border-destructive/50' : ''}`}
        />
        <span className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground text-[10px]">{unit}</span>
      </div>
      {isEmpty(value) && <p className="text-[10px] text-destructive">Required</p>}
    </div>
  );

  const ToggleRow = ({ checked, field, label, description, onFieldUpdate }: { checked: boolean; field: string; label: string; description: string; onFieldUpdate?: (key: string, value: number | boolean | null) => void }) => (
    <div className="flex items-center justify-between gap-3">
      <div>
        <Label className="text-xs font-medium">{label}</Label>
        <p className="text-[10px] text-muted-foreground">{description}</p>
      </div>
      <Switch
        checked={checked}
        onCheckedChange={(v) => (onFieldUpdate || onUpdate)(field, v)}
      />
    </div>
  );

  const phases = [
    {
      id: 'pickup-waiting',
      icon: Banknote,
      label: 'Pickup Waiting',
      color: 'text-amber-600',
      bgColor: 'bg-amber-500/10',
      borderColor: 'border-amber-500/30',
      subtitle: 'Free waiting begins on arrival at pickup, then waiting charges apply automatically',
      content: (
        <div className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <NumberInput value={freeWaitingMinutes} field="free_waiting_minutes" label="Free Pickup Waiting Time" unit="min" />
            <PenceInput value={waitingPerMinutePence} field="waiting_per_minute_pence" label="Pickup Waiting Rate (per min)" />
          </div>
          <ToggleRow
            checked={recalculateOnWaiting}
            field="recalculate_on_waiting"
            label="Enable Pickup Waiting Charge"
            description="Apply per-minute charge after free pickup waiting expires"
          />
          <div className="space-y-1 mt-2">
            <div className="flex items-center gap-2 text-xs">
              <Clock className="h-3.5 w-3.5 text-primary shrink-0" />
              <span className="text-muted-foreground">Waiting begins when driver marks arrived at pickup</span>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <Banknote className="h-3.5 w-3.5 text-amber-600 shrink-0" />
              <span className="text-muted-foreground">Charges start automatically after free pickup waiting time ends</span>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <Info className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <span className="text-muted-foreground">Stops when trip starts, cancels, or no-show is applied</span>
            </div>
          </div>
        </div>
      ),
    },
    {
      id: 'stop-waiting',
      icon: MapPin,
      label: 'Stop Waiting',
      color: 'text-green-600',
      bgColor: 'bg-green-500/10',
      borderColor: 'border-green-500/30',
      subtitle: 'Stop waiting starts automatically when the driver enters the configured GPS radius',
      content: (
        <div className="space-y-3">
          <div className="flex items-start gap-2 p-2 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-md">
            <Info className="h-3.5 w-3.5 text-blue-600 mt-0.5 shrink-0" />
            <p className="text-[11px] text-blue-700 dark:text-blue-400">
              Applies only to intermediate stops during an active trip. Stop waiting starts automatically when the driver enters the configured GPS radius. Paid waiting begins after the free stop waiting time expires. Driver taps <strong>"Drive to Next"</strong> to continue the trip.
            </p>
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <NumberInput value={stopWaitingGracePeriodSeconds} field="stopWaitingGracePeriodSeconds" label="Free Stop Waiting Time" unit="sec" onFieldUpdate={onStopWaitingUpdate} />
            <PenceInput value={stopWaitingRatePencePerMinute} field="stopWaitingRatePencePerMinute" label="Stop Waiting Rate (per min)" onFieldUpdate={onStopWaitingUpdate} />
          </div>

          <ToggleRow
            checked={recalculateOnWaiting}
            field="recalculate_on_waiting"
            label="Enable Stop Waiting Charge"
            description="Apply per-minute charge after free stop waiting time expires"
          />

          <div className="flex flex-wrap items-end gap-3">
            <NumberInput value={stopRadiusMeters} field="stopRadiusMeters" label="GPS Radius Restriction" unit="m" onFieldUpdate={onStopWaitingUpdate} min={1} />
            <NumberInput value={stopWaitingChargeIntervalSeconds} field="stopWaitingChargeIntervalSeconds" label="Charge Interval" unit="sec" onFieldUpdate={onStopWaitingUpdate} min={1} />
          </div>
        </div>
      ),
    },
    {
      id: 'no-show',
      icon: UserX,
      label: 'No-Show Eligible',
      color: 'text-destructive',
      bgColor: 'bg-destructive/10',
      borderColor: 'border-destructive/30',
      subtitle: 'Driver can mark passenger as no-show after total pickup waiting time',
      content: (
        <div className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <NumberInput value={noShowWaitMinutes} field="no_show_wait_time_minutes" label="No-Show Waiting Time" unit="min" />
            <PenceInput value={noShowFeePence} field="no_show_fee_pence" label="No-Show Fee" />
          </div>
          <ToggleRow
            checked={noShowApplyAfterArrivalOnly}
            field="no_show_apply_after_arrival_only"
            label="After Arrival Only"
            description="Only allow no-show if driver has arrived at pickup"
          />
          <div className="space-y-1 mt-2">
            <div className="flex items-center gap-2 text-xs">
              <UserX className="h-3.5 w-3.5 text-destructive shrink-0" />
              <span className="text-muted-foreground">Available after admin-configured wait time at pickup</span>
            </div>
          </div>
        </div>
      ),
    },
  ];

  return (
    <Card>
      <CardHeader className="pb-4">
        <CardTitle className="flex items-center gap-2 text-base">
          <Timer className="h-5 w-5 text-primary" />
          Trip Lifecycle — Waiting & Cancellation Rules
        </CardTitle>
        <CardDescription>
          All values are admin-controlled. No defaults are applied — every timing and fee field must be set manually.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-0">
        {/* Timeline */}
        <div className="relative">
          {phases.map((phase, index) => {
            const Icon = phase.icon;
            const isLast = index === phases.length - 1;

            return (
              <div key={phase.id} className="relative flex gap-4">
                <div className="flex flex-col items-center">
                  <div className={`w-10 h-10 rounded-full ${phase.bgColor} border-2 ${phase.borderColor} flex items-center justify-center shrink-0 z-10`}>
                    <Icon className={`h-5 w-5 ${phase.color}`} />
                  </div>
                  {!isLast && (
                    <div className="w-0.5 flex-1 bg-border min-h-[24px]" />
                  )}
                </div>

                <div className={`flex-1 ${isLast ? 'pb-0' : 'pb-6'}`}>
                  <div className="flex items-center gap-2 mb-2">
                    <h4 className="font-semibold text-sm text-foreground">{phase.label}</h4>
                    <Badge variant="outline" className="text-[10px] px-1.5 py-0 font-normal">
                      {phase.subtitle}
                    </Badge>
                  </div>
                  <div className="p-3 rounded-lg border bg-card">
                    {phase.content}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Late Passenger Cancellation */}
        <div className="mt-6 pt-4 border-t">
          <div className={`p-4 rounded-lg border ${lateCancelEnabled ? 'bg-orange-500/5 border-orange-500/20' : 'bg-muted/30 border-border'}`}>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Timer className={`h-4 w-4 ${lateCancelEnabled ? 'text-orange-600' : 'text-muted-foreground'}`} />
                <Label className="text-sm font-semibold">Late Passenger Cancellation</Label>
                <Badge variant={lateCancelEnabled ? 'default' : 'secondary'} className="text-[10px] px-1.5 py-0">
                  {lateCancelEnabled ? 'ACTIVE' : 'OFF'}
                </Badge>
              </div>
              <Switch
                checked={lateCancelEnabled}
                onCheckedChange={(v) => onUpdate('late_cancel_enabled', v)}
              />
            </div>
            <p className="text-xs text-muted-foreground mb-3">
              Cancellation fee applies close to scheduled pickup time
            </p>
            {lateCancelEnabled && (
              <div className="space-y-3">
                <div className="flex flex-wrap items-end gap-3">
                  <NumberInput value={lateCancelThresholdMinutes} field="late_cancel_threshold_minutes" label="Cancellation Threshold Before Pickup" unit="min" />
                  <PenceInput value={lateCancelFeePence} field="late_cancel_fee_pence" label="Late Cancellation Fee" />
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <AlertTriangle className="h-3.5 w-3.5 text-orange-600 shrink-0" />
                  <span className="text-muted-foreground">
                    Applies to scheduled/prebooked trips. Fee charges when passenger cancels within the configured threshold.
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
