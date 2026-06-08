import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
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
import {
  Clock, UserX, Timer, MapPin,
  AlertTriangle, Banknote, Info, Ban
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
  lateCancelAirportProtectionEnabled: boolean;
  lateCancelAirportFareThresholdPence: number;
  lateCancelAirportFeeType: string;
  lateCancelAirportFeePercentage: number;
  lateCancelAirportProtectionTrigger: string;
  cancellationApplyAfterArrivalOnly: boolean;
  noShowApplyAfterArrivalOnly: boolean;
  arrivalCancellationEnabled: boolean;
  arrivalCancellationFeePence: number;
  arrivalCancellationApplyAfterFreeWaitingExpired: boolean;
  arrivalCancellationAfterArrivalOnly: boolean;
  recalculateOnWaiting: boolean;
  currencySymbol: string;
  onUpdate: (key: string, value: number | boolean | string) => void;
  // Stop Waiting & Get Paid (from stop_waiting_settings)
  stopRadiusEnabled: boolean;
  stopRadiusMeters: number;
  stopWaitingChargeIntervalSeconds: number;
  stopWaitingGracePeriodMinutes: number;
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
  lateCancelAirportProtectionEnabled,
  lateCancelAirportFareThresholdPence,
  lateCancelAirportFeeType,
  lateCancelAirportFeePercentage,
  lateCancelAirportProtectionTrigger,
  noShowApplyAfterArrivalOnly,
  arrivalCancellationEnabled,
  arrivalCancellationFeePence,
  arrivalCancellationApplyAfterFreeWaitingExpired,
  arrivalCancellationAfterArrivalOnly,
  recalculateOnWaiting,
  currencySymbol,
  onUpdate,
  stopRadiusMeters,
  stopWaitingChargeIntervalSeconds,
  stopWaitingGracePeriodMinutes,
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

  const NumberInput = ({ value, field, label, unit, onFieldUpdate, min = 0, step }: { value: number; field: string; label: string; unit: string; onFieldUpdate?: (key: string, value: number | boolean | null) => void; min?: number; step?: number }) => (
    <div className="space-y-1">
      <Label className="text-xs font-medium">
        {label} <span className="text-destructive">*</span>
      </Label>
      <div className="relative">
        <Input
          type="number"
          min={min}
          step={step}
          placeholder="0"
          value={numToDisplay(value)}
          onChange={(e) => {
            const parsed = step != null && step < 1
              ? parseFloat(e.target.value)
              : parseInt(e.target.value, 10);
            (onFieldUpdate || onUpdate)(field, Number.isFinite(parsed) ? parsed : 0);
          }}
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
      subtitle: 'Free stop waiting starts when driver marks Arrived at Stop',
      content: (
        <div className="space-y-3">
          <div className="flex items-start gap-2 p-2 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-md">
            <Info className="h-3.5 w-3.5 text-blue-600 mt-0.5 shrink-0" />
            <p className="text-[11px] text-blue-700 dark:text-blue-400">
              Applies only to intermediate stops during an active trip. Free stop waiting begins when the driver marks <strong>Arrived at Stop</strong>. After the free stop waiting time expires, waiting charges accumulate automatically at the configured charge interval until the driver continues the trip. GPS Radius Restriction is used to validate stop arrival location and may trigger a confirmation warning if the driver is too far from the stop.
            </p>
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <NumberInput value={stopWaitingGracePeriodMinutes} field="stopWaitingGracePeriodMinutes" label="Free Stop Waiting Time" unit="min" onFieldUpdate={onStopWaitingUpdate} min={0} step={0.5} />
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

        {/* Arrival Cancellation Fee */}
        <div className="mt-6 pt-4 border-t">
          <div className={`p-4 rounded-lg border ${arrivalCancellationEnabled ? 'bg-rose-500/5 border-rose-500/20' : 'bg-muted/30 border-border'}`}>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Ban className={`h-4 w-4 ${arrivalCancellationEnabled ? 'text-rose-600' : 'text-muted-foreground'}`} />
                <Label className="text-sm font-semibold">Arrival Cancellation Fee</Label>
                <Badge variant={arrivalCancellationEnabled ? 'default' : 'secondary'} className="text-[10px] px-1.5 py-0">
                  Customer cancels after driver arrival
                </Badge>
              </div>
              <Switch
                checked={arrivalCancellationEnabled}
                onCheckedChange={(v) => onUpdate('arrival_cancellation_enabled', v)}
              />
            </div>
            <p className="text-xs text-muted-foreground mb-3">
              Fee when the customer cancels after the driver has arrived and free pickup waiting has expired — before a no-show is recorded. Not the same as the no-show fee or late passenger cancellation.
            </p>
            {arrivalCancellationEnabled && (
              <div className="space-y-3">
                <div className="flex flex-wrap items-end gap-3">
                  <PenceInput value={arrivalCancellationFeePence} field="arrival_cancellation_fee_pence" label="Fee Amount" />
                </div>
                <ToggleRow
                  checked={arrivalCancellationApplyAfterFreeWaitingExpired}
                  field="arrival_cancellation_apply_after_free_waiting_expired"
                  label="Apply After Free Pickup Waiting Expired"
                  description="Charge only once free pickup waiting time has ended"
                />
                <ToggleRow
                  checked={arrivalCancellationAfterArrivalOnly}
                  field="arrival_cancellation_after_arrival_only"
                  label="After Arrival Only"
                  description="Only apply when driver has arrived at pickup"
                />
                <div className="flex items-center gap-2 text-xs">
                  <AlertTriangle className="h-3.5 w-3.5 text-rose-600 shrink-0" />
                  <span className="text-muted-foreground">
                    Does not apply if the trip has started, a no-show was recorded, or late scheduled cancellation already covers the fee.
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Late Passenger Cancellation */}
        <div className="mt-4 pt-4 border-t">
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
                <div className="mt-4 pt-3 border-t border-orange-500/20 space-y-3">
                  <ToggleRow
                    checked={lateCancelAirportProtectionEnabled}
                    field="late_cancel_airport_protection_enabled"
                    label="Airport Protection Enabled"
                    description="Higher percentage fee for airport or long-distance prebooks after driver starts journey"
                  />
                  {lateCancelAirportProtectionEnabled && (
                    <>
                      <div className="flex flex-wrap items-end gap-3">
                        <PenceInput
                          value={lateCancelAirportFareThresholdPence}
                          field="late_cancel_airport_fare_threshold_pence"
                          label="Airport Fare Threshold"
                        />
                        <div className="space-y-1">
                          <Label className="text-xs font-medium">Airport Fee Type</Label>
                          <Select
                            value={lateCancelAirportFeeType}
                            onValueChange={(v) => onUpdate('late_cancel_airport_fee_type', v)}
                          >
                            <SelectTrigger className="h-8 w-36 text-sm">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="PERCENTAGE">Percentage</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        <NumberInput
                          value={lateCancelAirportFeePercentage}
                          field="late_cancel_airport_fee_percentage"
                          label="Airport Percentage"
                          unit="%"
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs font-medium">Protection Trigger</Label>
                        <Select
                          value={lateCancelAirportProtectionTrigger}
                          onValueChange={(v) => onUpdate('late_cancel_airport_protection_trigger', v)}
                        >
                          <SelectTrigger className="h-8 w-full max-w-md text-sm">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="AFTER_DRIVER_STARTED_JOURNEY">
                              After driver started journey to pickup
                            </SelectItem>
                          </SelectContent>
                        </Select>
                        <p className="text-[10px] text-muted-foreground">
                          Applies when estimated fare ≥ threshold or trip is flagged as airport.
                        </p>
                      </div>
                    </>
                  )}
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
