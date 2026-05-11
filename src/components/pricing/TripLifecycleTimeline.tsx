import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { 
  Car, Clock, Ban, UserX, Timer, MapPin,
  ShieldCheck, AlertTriangle, Banknote, Info
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
  // Stop Waiting & Get Paid (from dispatch_settings)
  stopRadiusEnabled: boolean;
  stopRadiusMeters: number;
  stopWaitingChargeIntervalSeconds: number;
  stopWaitingGracePeriodSeconds: number;
  stopWaitingRatePencePerMinute: number;
  stopWaitingMaxMinutes: number | null;
  onStopWaitingUpdate: (key: string, value: number | boolean | null) => void;
}

export function TripLifecycleTimeline({
  graceMinutes,
  freeWaitingMinutes,
  waitingPerMinutePence,
  cancellationFeePence,
  noShowWaitMinutes,
  noShowFeePence,
  lateCancelEnabled,
  lateCancelThresholdMinutes,
  lateCancelFeePence,
  cancellationApplyAfterArrivalOnly,
  noShowApplyAfterArrivalOnly,
  recalculateOnWaiting,
  currencySymbol,
  onUpdate,
  stopRadiusEnabled,
  stopRadiusMeters,
  stopWaitingChargeIntervalSeconds,
  stopWaitingGracePeriodSeconds,
  stopWaitingRatePencePerMinute,
  stopWaitingMaxMinutes,
  onStopWaitingUpdate,
}: TripLifecycleTimelineProps) {
  const penceToDisplay = (pence: number) => (pence / 100).toFixed(2);
  const displayToPence = (val: string) => Math.round(parseFloat(val || '0') * 100);

  const PenceInput = ({ value, field, label, onFieldUpdate }: { value: number; field: string; label: string; onFieldUpdate?: (key: string, value: number | boolean | null) => void }) => (
    <div className="space-y-1">
      <Label className="text-xs font-medium">{label}</Label>
      <div className="relative">
        <span className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground text-xs">{currencySymbol}</span>
        <Input
          type="number"
          step="0.01"
          min="0"
          value={penceToDisplay(value)}
          onChange={(e) => (onFieldUpdate || onUpdate)(field, displayToPence(e.target.value))}
          className="h-8 text-sm pl-6 w-28"
        />
      </div>
    </div>
  );

  const MinuteInput = ({ value, field, label, onFieldUpdate }: { value: number; field: string; label: string; onFieldUpdate?: (key: string, value: number | boolean | null) => void }) => (
    <div className="space-y-1">
      <Label className="text-xs font-medium">{label}</Label>
      <div className="relative">
        <Input
          type="number"
          min="0"
          value={value}
          onChange={(e) => (onFieldUpdate || onUpdate)(field, parseInt(e.target.value) || 0)}
          className="h-8 text-sm w-20 pr-8"
        />
        <span className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground text-xs">min</span>
      </div>
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
      id: 'assigned',
      icon: Car,
      label: 'Driver Assigned',
      color: 'text-primary',
      bgColor: 'bg-primary/10',
      borderColor: 'border-primary/30',
      subtitle: 'Passenger can cancel without charge during this period',
      content: (
        <div className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <MinuteInput value={graceMinutes} field="cancellation_grace_period_minutes" label="Grace Period" />
            <PenceInput value={cancellationFeePence} field="cancellation_fee_pence" label="Cancellation Fee" />
          </div>
          <ToggleRow
            checked={cancellationApplyAfterArrivalOnly}
            field="cancellation_apply_after_arrival_only"
            label="After Arrival Only"
            description="Only charge fee if driver has already arrived"
          />
          <div className="space-y-1 mt-2">
            <div className="flex items-center gap-2 text-xs">
              <ShieldCheck className="h-3.5 w-3.5 text-emerald-600 shrink-0" />
              <span className="text-muted-foreground">Cancel within <strong className="text-foreground">{graceMinutes} min</strong> → <strong className="text-emerald-600">FREE</strong></span>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <AlertTriangle className="h-3.5 w-3.5 text-amber-600 shrink-0" />
              <span className="text-muted-foreground">
                Cancel after {graceMinutes} min → {cancellationApplyAfterArrivalOnly 
                  ? <strong className="text-foreground">FREE (arrival-only mode)</strong>
                  : <strong className="text-foreground">{currencySymbol}{penceToDisplay(cancellationFeePence)} fee</strong>
                }
              </span>
            </div>
          </div>
        </div>
      ),
    },
    {
      id: 'arrived-paid-waiting',
      icon: Banknote,
      label: 'Driver Arrived & Paid Waiting',
      color: 'text-amber-600',
      bgColor: 'bg-amber-500/10',
      borderColor: 'border-amber-500/30',
      subtitle: 'Free waiting begins on arrival, then waiting charges apply after the free waiting time ends',
      content: (
        <div className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <MinuteInput value={freeWaitingMinutes} field="free_waiting_minutes" label="Free Waiting" />
            <PenceInput value={waitingPerMinutePence} field="waiting_per_minute_pence" label="Per Minute Rate" />
          </div>
          <ToggleRow
            checked={recalculateOnWaiting}
            field="recalculate_on_waiting"
            label="Enable Waiting Charge"
            description="Apply per-minute charge after free waiting expires"
          />
          <div className="space-y-1 mt-2">
            <div className="flex items-center gap-2 text-xs">
              <ShieldCheck className="h-3.5 w-3.5 text-emerald-600 shrink-0" />
              <span className="text-muted-foreground">Cancel within <strong className="text-foreground">{graceMinutes} min</strong> of arrival → <strong className="text-emerald-600">FREE</strong></span>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <AlertTriangle className="h-3.5 w-3.5 text-amber-600 shrink-0" />
              <span className="text-muted-foreground">Cancel after grace → <strong className="text-foreground">{currencySymbol}{penceToDisplay(cancellationFeePence)} fee</strong></span>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <Clock className="h-3.5 w-3.5 text-primary shrink-0" />
              <span className="text-muted-foreground">Free waiting for <strong className="text-foreground">{freeWaitingMinutes} min</strong> — no charge</span>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <Banknote className="h-3.5 w-3.5 text-amber-600 shrink-0" />
              <span className="text-muted-foreground"><strong className="text-foreground">{currencySymbol}{penceToDisplay(waitingPerMinutePence)}/min</strong> charged automatically after free waiting</span>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <Ban className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <span className="text-muted-foreground">Stops when trip starts, cancels, or no-show</span>
            </div>
          </div>
        </div>
      ),
    },
    {
      id: 'stop-waiting',
      icon: MapPin,
      label: 'Stop Waiting & Get Paid',
      color: 'text-green-600',
      bgColor: 'bg-green-500/10',
      borderColor: 'border-green-500/30',
      subtitle: 'Driver manually starts waiting charges by tapping "Get Paid"',
      content: (
        <div className="space-y-3">
          <div className="flex items-start gap-2 p-2 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-md">
            <Info className="h-3.5 w-3.5 text-blue-600 mt-0.5 shrink-0" />
            <p className="text-[11px] text-blue-700 dark:text-blue-400">
              Driver taps <strong>"Get Paid"</strong> at a stop → waiting charge accumulates live → taps <strong>"Next"</strong> to stop charging and navigate onward.
            </p>
          </div>

          <ToggleRow
            checked={stopRadiusEnabled}
            field="stopRadiusEnabled"
            label="GPS Radius Restriction"
            description="Only show button when driver is near the stop"
            onFieldUpdate={onStopWaitingUpdate}
          />

          {stopRadiusEnabled && (
            <div className="space-y-1">
              <Label className="text-xs font-medium">Stop Radius</Label>
              <div className="relative">
                <Input
                  type="number"
                  min="10"
                  max="1000"
                  step="10"
                  value={stopRadiusMeters}
                  onChange={(e) => onStopWaitingUpdate('stopRadiusMeters', Math.max(10, Math.min(1000, parseInt(e.target.value) || 100)))}
                  className="h-8 text-sm w-24 pr-6"
                />
                <span className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground text-xs">m</span>
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-end gap-3">
            <PenceInput value={stopWaitingRatePencePerMinute} field="stopWaitingRatePencePerMinute" label="Rate (per min)" onFieldUpdate={onStopWaitingUpdate} />
            <div className="space-y-1">
              <Label className="text-xs font-medium">Charge Interval</Label>
              <div className="relative">
                <Input
                  type="number"
                  min="5"
                  max="60"
                  value={stopWaitingChargeIntervalSeconds}
                  onChange={(e) => onStopWaitingUpdate('stopWaitingChargeIntervalSeconds', Math.max(5, Math.min(60, parseInt(e.target.value) || 10)))}
                  className="h-8 text-sm w-20 pr-4"
                />
                <span className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground text-xs">s</span>
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs font-medium">Grace Period</Label>
              <div className="relative">
                <Input
                  type="number"
                  min="0"
                  max="300"
                  value={stopWaitingGracePeriodSeconds}
                  onChange={(e) => onStopWaitingUpdate('stopWaitingGracePeriodSeconds', Math.max(0, Math.min(300, parseInt(e.target.value) || 0)))}
                  className="h-8 text-sm w-20 pr-4"
                />
                <span className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground text-xs">s</span>
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs font-medium">Max Wait</Label>
              <div className="relative">
                <Input
                  type="number"
                  min="0"
                  max="120"
                  value={stopWaitingMaxMinutes ?? 0}
                  onChange={(e) => {
                    const val = parseInt(e.target.value) || 0;
                    onStopWaitingUpdate('stopWaitingMaxMinutes', val === 0 ? null : val);
                  }}
                  className="h-8 text-sm w-20 pr-8"
                />
                <span className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground text-xs">min</span>
              </div>
            </div>
          </div>

          <div className="space-y-1 mt-2">
            <div className="flex items-center gap-2 text-xs">
              <Banknote className="h-3.5 w-3.5 text-green-600 shrink-0" />
              <span className="text-muted-foreground"><strong className="text-foreground">{currencySymbol}{penceToDisplay(stopWaitingRatePencePerMinute)}/min</strong> • updates every {stopWaitingChargeIntervalSeconds}s</span>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <Clock className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <span className="text-muted-foreground">{stopWaitingGracePeriodSeconds === 0 ? 'No grace — charges start immediately' : `${stopWaitingGracePeriodSeconds}s free before charging`}</span>
            </div>
            {stopWaitingMaxMinutes && (
              <div className="flex items-center gap-2 text-xs">
                <Timer className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <span className="text-muted-foreground">Max <strong className="text-foreground">{stopWaitingMaxMinutes} min</strong> per stop</span>
              </div>
            )}
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
      subtitle: `After ${noShowWaitMinutes} min total wait`,
      content: (
        <div className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <MinuteInput value={noShowWaitMinutes} field="no_show_wait_time_minutes" label="Wait Time" />
            <PenceInput value={noShowFeePence} field="no_show_fee_pence" label="No-Show Fee" />
          </div>
          <ToggleRow
            checked={noShowApplyAfterArrivalOnly}
            field="no_show_apply_after_arrival_only"
            label="After Arrival Only"
            description="Only allow no-show if driver has arrived"
          />
          <div className="space-y-1 mt-2">
            <div className="flex items-center gap-2 text-xs">
              <UserX className="h-3.5 w-3.5 text-destructive shrink-0" />
              <span className="text-muted-foreground">After <strong className="text-foreground">{noShowWaitMinutes} min</strong> → driver can tap "No Show"</span>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <AlertTriangle className="h-3.5 w-3.5 text-destructive shrink-0" />
              <span className="text-muted-foreground">Customer charged <strong className="text-foreground">{currencySymbol}{penceToDisplay(noShowFeePence)}</strong></span>
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
          Configure how waiting, cancellation, and no-show rules apply at each phase. Changes apply to all trips in this service area.
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
                {/* Timeline line + dot */}
                <div className="flex flex-col items-center">
                  <div className={`w-10 h-10 rounded-full ${phase.bgColor} border-2 ${phase.borderColor} flex items-center justify-center shrink-0 z-10`}>
                    <Icon className={`h-5 w-5 ${phase.color}`} />
                  </div>
                  {!isLast && (
                    <div className="w-0.5 flex-1 bg-border min-h-[24px]" />
                  )}
                </div>

                {/* Content */}
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

        {/* Late Cancellation */}
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
              Fee applied when a passenger cancels too close to a scheduled pickup time
            </p>
            {lateCancelEnabled && (
              <div className="space-y-3">
                <div className="flex flex-wrap items-end gap-3">
                  <MinuteInput value={lateCancelThresholdMinutes} field="late_cancel_threshold_minutes" label="Threshold (before pickup)" />
                  <PenceInput value={lateCancelFeePence} field="late_cancel_fee_pence" label="Late Cancel Fee" />
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <AlertTriangle className="h-3.5 w-3.5 text-orange-600 shrink-0" />
                  <span className="text-muted-foreground">
                    Cancel within <strong className="text-foreground">{lateCancelThresholdMinutes} min</strong> of scheduled pickup → <strong className="text-foreground">{currencySymbol}{penceToDisplay(lateCancelFeePence)}</strong> fee
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
