import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { 
  Car, Clock, Ban, UserX, Timer, 
  CheckCircle2, ShieldCheck, AlertTriangle, Banknote
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
}: TripLifecycleTimelineProps) {
  const penceToDisplay = (pence: number) => (pence / 100).toFixed(2);
  const displayToPence = (val: string) => Math.round(parseFloat(val || '0') * 100);

  const PenceInput = ({ value, field, label }: { value: number; field: string; label: string }) => (
    <div className="space-y-1">
      <Label className="text-xs font-medium">{label}</Label>
      <div className="relative">
        <span className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground text-xs">{currencySymbol}</span>
        <Input
          type="number"
          step="0.01"
          min="0"
          value={penceToDisplay(value)}
          onChange={(e) => onUpdate(field, displayToPence(e.target.value))}
          className="h-8 text-sm pl-6 w-28"
        />
      </div>
    </div>
  );

  const MinuteInput = ({ value, field, label }: { value: number; field: string; label: string }) => (
    <div className="space-y-1">
      <Label className="text-xs font-medium">{label}</Label>
      <div className="relative">
        <Input
          type="number"
          min="0"
          value={value}
          onChange={(e) => onUpdate(field, parseInt(e.target.value) || 0)}
          className="h-8 text-sm w-20 pr-8"
        />
        <span className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground text-xs">min</span>
      </div>
    </div>
  );

  const ToggleRow = ({ checked, field, label, description }: { checked: boolean; field: string; label: string; description: string }) => (
    <div className="flex items-center justify-between gap-3">
      <div>
        <Label className="text-xs font-medium">{label}</Label>
        <p className="text-[10px] text-muted-foreground">{description}</p>
      </div>
      <Switch
        checked={checked}
        onCheckedChange={(v) => onUpdate(field, v)}
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
      subtitle: 'Post-booking cancellation grace period',
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
      id: 'arrived',
      icon: CheckCircle2,
      label: 'Driver Arrived',
      color: 'text-emerald-600',
      bgColor: 'bg-emerald-500/10',
      borderColor: 'border-emerald-500/30',
      subtitle: 'Grace resets + free waiting begins',
      content: (
        <div className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <MinuteInput value={freeWaitingMinutes} field="free_waiting_minutes" label="Free Waiting" />
          </div>
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
          </div>
        </div>
      ),
    },
    {
      id: 'paid-waiting',
      icon: Banknote,
      label: 'Paid Waiting',
      color: 'text-amber-600',
      bgColor: 'bg-amber-500/10',
      borderColor: 'border-amber-500/30',
      subtitle: `Starts after ${freeWaitingMinutes} min free waiting`,
      content: (
        <div className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
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
              <Banknote className="h-3.5 w-3.5 text-amber-600 shrink-0" />
              <span className="text-muted-foreground"><strong className="text-foreground">{currencySymbol}{penceToDisplay(waitingPerMinutePence)}/min</strong> charged automatically</span>
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
