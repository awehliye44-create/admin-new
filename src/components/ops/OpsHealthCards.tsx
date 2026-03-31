import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import {
  CreditCard, Percent, Wallet, DollarSign, Truck, Globe, Building2,
  Smartphone, Car, Server, ScrollText, Copy, Activity
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

type HealthSummary = Record<string, { open: number; critical: number; latest: string | null }>;

interface OpsHealthCardsProps {
  data: HealthSummary | undefined;
  loading: boolean;
  onCategoryClick: (category: string) => void;
}

const CATEGORY_CONFIG: { key: string; label: string; icon: React.ReactNode }[] = [
  { key: 'payment', label: 'Payments', icon: <CreditCard className="h-5 w-5" /> },
  { key: 'commission', label: 'Commissions', icon: <Percent className="h-5 w-5" /> },
  { key: 'earning', label: 'Driver Earnings', icon: <Wallet className="h-5 w-5" /> },
  { key: 'payout', label: 'Payouts', icon: <DollarSign className="h-5 w-5" /> },
  { key: 'dispatch', label: 'Dispatch', icon: <Truck className="h-5 w-5" /> },
  { key: 'guest_booking', label: 'Guest Booking', icon: <Globe className="h-5 w-5" /> },
  { key: 'corporate_booking', label: 'Corporate', icon: <Building2 className="h-5 w-5" /> },
  { key: 'customer_app', label: 'Customer App', icon: <Smartphone className="h-5 w-5" /> },
  { key: 'driver_app', label: 'Driver App', icon: <Car className="h-5 w-5" /> },
  { key: 'backend', label: 'Backend/API', icon: <Server className="h-5 w-5" /> },
  { key: 'logs', label: 'Logs & Errors', icon: <ScrollText className="h-5 w-5" /> },
  { key: 'duplication', label: 'Duplications', icon: <Copy className="h-5 w-5" /> },
  { key: 'system', label: 'System', icon: <Activity className="h-5 w-5" /> },
];

function getHealthColor(open: number, critical: number): string {
  if (critical > 0) return 'border-destructive/50 bg-destructive/5';
  if (open > 0) return 'border-amber-500/50 bg-amber-500/5';
  return 'border-emerald-500/30 bg-emerald-500/5';
}

function getStatusDot(open: number, critical: number): string {
  if (critical > 0) return 'bg-destructive';
  if (open > 0) return 'bg-amber-500';
  return 'bg-emerald-500';
}

export function OpsHealthCards({ data, loading, onCategoryClick }: OpsHealthCardsProps) {
  if (loading) {
    return (
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-7 gap-3">
        {Array.from({ length: 13 }).map((_, i) => (
          <Card key={i} className="animate-pulse">
            <CardContent className="p-4 h-24" />
          </Card>
        ))}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-7 gap-3">
      {CATEGORY_CONFIG.map(({ key, label, icon }) => {
        const stats = data?.[key] || { open: 0, critical: 0, latest: null };
        return (
          <Card
            key={key}
            className={cn(
              'cursor-pointer transition-all hover:shadow-md border',
              getHealthColor(stats.open, stats.critical)
            )}
            onClick={() => onCategoryClick(key)}
          >
            <CardContent className="p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-muted-foreground">{icon}</span>
                <span className={cn('h-2.5 w-2.5 rounded-full', getStatusDot(stats.open, stats.critical))} />
              </div>
              <p className="text-xs font-medium text-muted-foreground truncate">{label}</p>
              <p className="text-lg font-bold text-foreground">{stats.open}</p>
              {stats.latest && (
                <p className="text-[10px] text-muted-foreground truncate mt-1">
                  {formatDistanceToNow(new Date(stats.latest), { addSuffix: true })}
                </p>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
