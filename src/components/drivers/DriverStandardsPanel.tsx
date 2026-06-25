import { useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Loader2,
  Shield,
  Star,
  ThumbsDown,
  ThumbsUp,
  TrendingUp,
  XCircle,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Button } from '@/components/ui/button';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import { useDriverStandards } from '@/hooks/useDriverStandards';
import {
  DRIVER_STANDARDS_COPY,
  formatRate,
  formatRating,
  metricQualityLabel,
  type DriverStandardsData,
  type DriverStandardsStatus,
} from '@/lib/driverStandardsTypes';

const PERIOD_OPTIONS = [7, 30, 90] as const;

function statusVariant(status: DriverStandardsStatus): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (status) {
    case 'excellent':
      return 'default';
    case 'good':
      return 'secondary';
    case 'at_risk':
      return 'destructive';
    default:
      return 'outline';
  }
}

function MetricTile({
  title,
  value,
  quality,
  subtext,
}: {
  title: string;
  value: string;
  quality: string | null;
  subtext: string;
}) {
  const numeric = parseFloat(value);
  const progress = Number.isFinite(numeric) ? Math.min(100, Math.max(0, numeric)) : 0;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-sm font-medium">{title}</CardTitle>
          {quality ? <Badge variant="outline">{quality}</Badge> : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-2xl font-bold tabular-nums">{value}</p>
        <Progress value={progress} className="h-2" />
        <p className="text-xs text-muted-foreground">{subtext}</p>
      </CardContent>
    </Card>
  );
}

function formatActivityTime(iso: string) {
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

interface DriverStandardsPanelProps {
  driverId: string;
  driverName?: string;
  displayRating?: number | null;
}

export function DriverStandardsPanel({
  driverId,
  driverName,
  displayRating,
}: DriverStandardsPanelProps) {
  const [periodDays, setPeriodDays] = useState<number>(30);
  const { data, isLoading, isError, refetch, isFetching } = useDriverStandards(driverId, periodDays);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="h-6 w-6 animate-spin mr-2" />
        Loading driver standards…
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="rounded-lg border border-dashed p-8 text-center space-y-3">
        <p className="text-sm text-muted-foreground">Unable to load driver standards.</p>
        <Button variant="outline" size="sm" onClick={() => refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  return (
    <DriverStandardsPanelContent
      data={data}
      driverName={driverName}
      displayRating={displayRating}
      periodDays={periodDays}
      onPeriodChange={setPeriodDays}
      isRefreshing={isFetching}
    />
  );
}

export function DriverStandardsPanelContent({
  data,
  driverName,
  displayRating,
  periodDays,
  onPeriodChange,
  isRefreshing = false,
}: {
  data: DriverStandardsData;
  driverName?: string;
  displayRating?: number | null;
  periodDays: number;
  onPeriodChange: (days: number) => void;
  isRefreshing?: boolean;
}) {
  const breakdownRows = [5, 4, 3, 2, 1].map((stars) => ({
    stars,
    count: Number(data.rating_breakdown[String(stars)] ?? 0),
  }));
  const maxBreakdown = Math.max(...breakdownRows.map((r) => r.count), 1);
  const positiveTags = data.customer_feedback_tags.filter((t) =>
    ['Excellent service', 'Smooth journey', 'Friendly driver', 'Clean car', 'Punctual arrival', 'Safe driving'].includes(t.tag),
  );
  const negativeTags = data.customer_feedback_tags.filter((t) =>
    !positiveTags.some((p) => p.tag === t.tag),
  );

  const trendData = data.performance_trend.map((point) => ({
    ...point,
    label: point.date.slice(5),
  }));

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="text-lg font-semibold">Driver Standards</h3>
          <p className="text-sm text-muted-foreground">
            Performance overview{driverName ? ` for ${driverName}` : ''} — last {periodDays} days
          </p>
          <p className="text-xs text-muted-foreground mt-1">{data.metrics_refresh_note}</p>
        </div>
        <div className="flex items-center gap-2">
          {isRefreshing ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : null}
          {PERIOD_OPTIONS.map((days) => (
            <Button
              key={days}
              size="sm"
              variant={periodDays === days ? 'default' : 'outline'}
              onClick={() => onPeriodChange(days)}
            >
              {days}d
            </Button>
          ))}
        </div>
      </div>

      {data.warning_banner ? (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 flex gap-3">
          <AlertTriangle className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold">{data.warning_banner.title}</p>
            <p className="text-sm text-muted-foreground mt-1">{data.warning_banner.message}</p>
          </div>
        </div>
      ) : null}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle className="text-sm font-medium">Customer rating</CardTitle>
          </CardHeader>
          <CardContent className="flex items-center justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <span className="text-3xl font-bold tabular-nums">
                  {displayRating != null ? displayRating.toFixed(2) : formatRating(data.average_rating)}
                </span>
                <div className="flex gap-0.5">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <Star
                      key={i}
                      className={`h-4 w-4 ${
                        i < Math.round(data.average_rating ?? displayRating ?? 0)
                          ? 'text-yellow-500 fill-yellow-500'
                          : 'text-muted-foreground/30'
                      }`}
                    />
                  ))}
                </div>
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                {data.rating_count > 0
                  ? DRIVER_STANDARDS_COPY.basedOnRatings(data.rating_count, data.rating_window_size)
                  : DRIVER_STANDARDS_COPY.notEnoughData}
              </p>
            </div>
            <Badge variant={statusVariant(data.driver_status)} className="gap-1 px-3 py-2">
              <Shield className="h-4 w-4" />
              {DRIVER_STANDARDS_COPY.statusLabels[data.driver_status]}
            </Badge>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Your status</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm font-medium">{DRIVER_STANDARDS_COPY.statusLabels[data.driver_status]}</p>
            <p className="text-sm text-muted-foreground mt-2">
              {DRIVER_STANDARDS_COPY.statusMessages[data.driver_status]}
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        <MetricTile
          title="Acceptance rate"
          value={formatRate(data.acceptance_rate)}
          quality={metricQualityLabel('acceptance', data.acceptance_rate)}
          subtext={`Trips accepted ${data.accepted_offers} / ${data.total_offers}`}
        />
        <MetricTile
          title="Pickup reliability"
          value={formatRate(data.pickup_reliability_rate)}
          quality={metricQualityLabel('pickup', data.pickup_reliability_rate)}
          subtext={`Prompt pickup starts ${data.pickup_reliable_trips} / ${data.accepted_trips}`}
        />
        <MetricTile
          title="On-time arrival"
          value={formatRate(data.on_time_arrival_rate)}
          quality={metricQualityLabel('on_time', data.on_time_arrival_rate)}
          subtext={`Within expected window ${data.on_time_arrivals} / ${data.accepted_trips}`}
        />
        <MetricTile
          title="Cancellation rate"
          value={formatRate(data.cancellation_rate)}
          quality={metricQualityLabel('cancellation', data.cancellation_rate)}
          subtext={`Driver cancellations ${data.driver_cancelled_trips} / ${data.accepted_trips}`}
        />
        <MetricTile
          title="Trip completion rate"
          value={formatRate(data.completion_rate)}
          quality={metricQualityLabel('completion', data.completion_rate)}
          subtext={`Completed ${data.completed_trips} / ${data.accepted_trips}`}
        />
        <MetricTile
          title="Customer rating"
          value={data.average_rating != null ? formatRating(data.average_rating) : '—'}
          quality={metricQualityLabel('rating', data.average_rating)}
          subtext={
            data.rating_count > 0
              ? DRIVER_STANDARDS_COPY.basedOnRatings(data.rating_count, data.rating_window_size)
              : DRIVER_STANDARDS_COPY.notEnoughData
          }
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Star rating breakdown</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {breakdownRows.map((row) => (
              <div key={row.stars} className="flex items-center gap-3">
                <div className="w-10 flex items-center gap-1 text-sm">
                  {row.stars}
                  <Star className="h-3.5 w-3.5 text-yellow-500 fill-yellow-500" />
                </div>
                <Progress
                  value={maxBreakdown > 0 ? Math.round((row.count / maxBreakdown) * 100) : 0}
                  className="flex-1 h-2"
                />
                <span className="w-8 text-right text-sm tabular-nums">{row.count}</span>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">What customers say</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {positiveTags.length === 0 && negativeTags.length === 0 ? (
              <p className="text-sm text-muted-foreground">{DRIVER_STANDARDS_COPY.notEnoughData}</p>
            ) : (
              <>
                {positiveTags.map((tag) => (
                  <div key={tag.tag} className="flex items-center justify-between text-sm">
                    <span className="inline-flex items-center gap-2">
                      <ThumbsUp className="h-4 w-4 text-emerald-500" />
                      {tag.tag}
                    </span>
                    <span className="text-muted-foreground tabular-nums">{tag.count}</span>
                  </div>
                ))}
                {negativeTags.map((tag) => (
                  <div key={tag.tag} className="flex items-center justify-between text-sm">
                    <span className="inline-flex items-center gap-2">
                      <ThumbsDown className="h-4 w-4 text-rose-500" />
                      {tag.tag}
                    </span>
                    <span className="text-muted-foreground tabular-nums">{tag.count}</span>
                  </div>
                ))}
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Performance trend</CardTitle>
        </CardHeader>
        <CardContent className="h-72">
          {trendData.length === 0 ? (
            <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
              {DRIVER_STANDARDS_COPY.notEnoughData}
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={trendData}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey="label" tick={{ fontSize: 12 }} />
                <YAxis domain={[0, 100]} tick={{ fontSize: 12 }} />
                <Tooltip />
                <Legend />
                <Line type="monotone" dataKey="acceptance_rate" name="Acceptance" stroke="#22c55e" dot={false} />
                <Line type="monotone" dataKey="pickup_reliability_rate" name="Pickup reliability" stroke="#3b82f6" dot={false} />
                <Line type="monotone" dataKey="on_time_arrival_rate" name="On-time arrival" stroke="#a855f7" dot={false} />
                <Line type="monotone" dataKey="cancellation_rate" name="Cancellation" stroke="#ef4444" dot={false} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Recent activity</CardTitle>
          </CardHeader>
          <CardContent>
            {data.recent_activity.length === 0 ? (
              <p className="text-sm text-muted-foreground">{DRIVER_STANDARDS_COPY.notEnoughData}</p>
            ) : (
              <ul className="space-y-3">
                {data.recent_activity.map((item, idx) => (
                  <li key={`${item.kind}-${item.at}-${idx}`} className="flex items-center justify-between gap-3 text-sm">
                    <span className="inline-flex items-center gap-2 min-w-0">
                      {item.kind === 'trip_completed' ? (
                        <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                      ) : item.kind === 'new_rating' ? (
                        <Star className="h-4 w-4 text-amber-500 fill-amber-500" />
                      ) : (
                        <XCircle className="h-4 w-4 text-red-500" />
                      )}
                      <span className="truncate">{item.label}</span>
                    </span>
                    <span className="text-xs text-muted-foreground inline-flex items-center gap-1 shrink-0">
                      <Clock className="h-3 w-3" />
                      {formatActivityTime(item.at)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Data overview</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between gap-3">
              <span className="text-muted-foreground">Period</span>
              <span className="font-medium">Last {data.period_days} days</span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-muted-foreground">Accepted trips</span>
              <span className="font-medium tabular-nums">{data.accepted_trips}</span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-muted-foreground">Completed trips</span>
              <span className="font-medium tabular-nums">{data.completed_trips}</span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-muted-foreground">Offers received</span>
              <span className="font-medium tabular-nums">{data.total_offers}</span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-muted-foreground">Last updated</span>
              <span className="font-medium inline-flex items-center gap-1">
                <TrendingUp className="h-3.5 w-3.5 text-muted-foreground" />
                {formatActivityTime(data.last_updated_at)}
              </span>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
