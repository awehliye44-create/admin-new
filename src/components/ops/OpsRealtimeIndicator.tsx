import { cn } from '@/lib/utils';
import { Wifi, WifiOff, Loader2 } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

interface OpsRealtimeIndicatorProps {
  status: 'connecting' | 'connected' | 'disconnected' | 'error';
  lastEvent: Date | null;
}

export function OpsRealtimeIndicator({ status, lastEvent }: OpsRealtimeIndicatorProps) {
  const config = {
    connecting: { icon: Loader2, color: 'text-amber-500', bg: 'bg-amber-500', label: 'Connecting…', animate: true },
    connected: { icon: Wifi, color: 'text-emerald-500', bg: 'bg-emerald-500', label: 'Live', animate: false },
    disconnected: { icon: WifiOff, color: 'text-muted-foreground', bg: 'bg-muted-foreground', label: 'Disconnected', animate: false },
    error: { icon: WifiOff, color: 'text-destructive', bg: 'bg-destructive', label: 'Connection error', animate: false },
  }[status];

  const Icon = config.icon;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-muted/60 border border-border/50">
            <span className="relative flex h-2 w-2">
              {status === 'connected' && (
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
              )}
              <span className={cn('relative inline-flex rounded-full h-2 w-2', config.bg)} />
            </span>
            <Icon className={cn('h-3.5 w-3.5', config.color, config.animate && 'animate-spin')} />
            <span className={cn('text-xs font-medium', config.color)}>{config.label}</span>
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p className="text-xs">
            Realtime: {config.label}
            {lastEvent && (
              <span className="block text-muted-foreground">
                Last update: {formatDistanceToNow(lastEvent, { addSuffix: true })}
              </span>
            )}
          </p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
