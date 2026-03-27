import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { 
  Car, Clock, Ban, UserX, Timer, 
  CheckCircle2, ArrowRight, ShieldCheck, AlertTriangle, Banknote
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
  currencySymbol: string;
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
  currencySymbol,
}: TripLifecycleTimelineProps) {
  const fmt = (pence: number) => `${currencySymbol}${(pence / 100).toFixed(2)}`;

  const phases = [
    {
      id: 'assigned',
      icon: Car,
      label: 'Driver Assigned',
      color: 'text-primary',
      bgColor: 'bg-primary/10',
      borderColor: 'border-primary/30',
      detail: `Grace period: ${graceMinutes} min`,
      rules: [
        { text: `Cancel within ${graceMinutes} min → FREE`, icon: ShieldCheck, variant: 'success' as const },
        ...(cancellationApplyAfterArrivalOnly
          ? [{ text: `Cancel after ${graceMinutes} min → FREE (arrival-only mode)`, icon: ShieldCheck, variant: 'success' as const }]
          : [{ text: `Cancel after ${graceMinutes} min → ${fmt(cancellationFeePence)} fee`, icon: AlertTriangle, variant: 'warning' as const }]
        ),
      ],
    },
    {
      id: 'arrived',
      icon: CheckCircle2,
      label: 'Driver Arrived',
      color: 'text-emerald-600',
      bgColor: 'bg-emerald-500/10',
      borderColor: 'border-emerald-500/30',
      detail: `Grace resets + Free waiting: ${freeWaitingMinutes} min`,
      rules: [
        { text: `Cancel within ${graceMinutes} min → FREE`, icon: ShieldCheck, variant: 'success' as const },
        { text: `Cancel after ${graceMinutes} min → ${fmt(cancellationFeePence)} fee`, icon: AlertTriangle, variant: 'warning' as const },
        { text: `Free waiting for ${freeWaitingMinutes} min`, icon: Clock, variant: 'info' as const },
      ],
    },
    {
      id: 'paid-waiting',
      icon: Banknote,
      label: 'Paid Waiting',
      color: 'text-amber-600',
      bgColor: 'bg-amber-500/10',
      borderColor: 'border-amber-500/30',
      detail: `After ${freeWaitingMinutes} min free waiting`,
      rules: [
        { text: `${fmt(waitingPerMinutePence)}/min charged`, icon: Banknote, variant: 'warning' as const },
        { text: 'Stops when trip starts, cancels, or no-show', icon: Ban, variant: 'info' as const },
      ],
    },
    {
      id: 'no-show',
      icon: UserX,
      label: 'No-Show Eligible',
      color: 'text-destructive',
      bgColor: 'bg-destructive/10',
      borderColor: 'border-destructive/30',
      detail: `After ${noShowWaitMinutes} min total wait`,
      rules: [
        { text: `Driver can tap "No Show"`, icon: UserX, variant: 'error' as const },
        { text: `No-show fee: ${fmt(noShowFeePence)}`, icon: AlertTriangle, variant: 'error' as const },
      ],
    },
  ];

  return (
    <Card>
      <CardHeader className="pb-4">
        <CardTitle className="flex items-center gap-2 text-base">
          <Timer className="h-5 w-5 text-primary" />
          Trip Lifecycle Timeline
        </CardTitle>
        <CardDescription>
          Visual overview of how waiting, cancellation, and no-show rules apply at each phase of a trip
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
                    <div className="w-0.5 h-full bg-border min-h-[24px]" />
                  )}
                </div>

                {/* Content */}
                <div className={`flex-1 pb-6 ${isLast ? 'pb-0' : ''}`}>
                  <div className="flex items-center gap-2 mb-1">
                    <h4 className="font-semibold text-sm text-foreground">{phase.label}</h4>
                    <Badge variant="outline" className="text-[10px] px-1.5 py-0 font-normal">
                      {phase.detail}
                    </Badge>
                  </div>
                  <div className="space-y-1.5 mt-2">
                    {phase.rules.map((rule, rIdx) => {
                      const RuleIcon = rule.icon;
                      const variantStyles = {
                        success: 'bg-emerald-500/10 text-emerald-700 border-emerald-500/20',
                        warning: 'bg-amber-500/10 text-amber-700 border-amber-500/20',
                        error: 'bg-destructive/10 text-destructive border-destructive/20',
                        info: 'bg-primary/5 text-primary border-primary/20',
                      };
                      return (
                        <div
                          key={rIdx}
                          className={`flex items-center gap-2 px-3 py-1.5 rounded-md border text-xs ${variantStyles[rule.variant]}`}
                        >
                          <RuleIcon className="h-3.5 w-3.5 shrink-0" />
                          <span>{rule.text}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Late Cancellation Badge */}
        {lateCancelEnabled && (
          <div className="mt-4 pt-4 border-t">
            <div className="flex items-start gap-3 p-3 rounded-lg bg-orange-500/5 border border-orange-500/20">
              <Timer className="h-4 w-4 text-orange-600 mt-0.5 shrink-0" />
              <div>
                <p className="text-xs font-medium text-orange-700">Late Passenger Cancellation Active</p>
                <p className="text-xs text-orange-600/80 mt-0.5">
                  If passenger cancels within <strong>{lateCancelThresholdMinutes} min</strong> of scheduled pickup → <strong>{fmt(lateCancelFeePence)}</strong> fee
                </p>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
