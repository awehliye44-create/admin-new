import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { format, subDays, startOfDay, endOfDay } from "date-fns";
import { CalendarIcon, Activity, Send, Timer, RefreshCw, CheckCircle2, AlertCircle, XCircle, ChevronDown, Users, ShieldAlert } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { AdminLayout } from "@/components/layout/AdminLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { QueryErrorState } from "@/components/QueryErrorState";
import { cn } from "@/lib/utils";
import { useRegions } from "@/hooks/useRegions";
import { useServiceAreas } from "@/hooks/useServiceAreas";
import {
  ResponsiveContainer, LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from "recharts";

type Preset = "today" | "24h" | "7d" | "custom";

interface DispatchMetricsResult {
  offered: number;
  received: number;
  ack_success_rate: number | null;
  socket_delivered: number;
  socket_success_rate: number | null;
  push_enqueued: number;
  push_skip_no_token?: number;
  push_sent: number;
  push_failed: number;
  reminder_scheduler_failed?: number;
  push_success_rate: number | null;
  avg_accept_seconds: number;
  total_offers: number;
  reassigned_offers: number;
  reassigned_pct: number | null;
  accepted_offers: number;
  acceptance_rate: number | null;
  expired_offers: number;
  timeout_rate: number | null;
  fallback_offers: number;
  fallback_rate: number | null;
  trips_evaluated: number;
  trips_no_eligible: number;
  no_eligible_rate: number | null;
  timeline: Array<{ bucket: string; offered: number; received: number }>;
  hourly_failures: Array<{ bucket: string; timeout: number; reassigned: number }>;
  recent_failures: Array<{
    booking_id: string; driver_id: string | null; offer_id: string | null;
    phase: string; failure_reason: string; created_at: string; last_event_at: string;
  }>;
  debug?: {
    retry_delivery_count: number;
    metrics_basis: string;
    push_eligible?: number;
    reminder_scheduler_failed?: number;
  };
}

type Health = "healthy" | "warning" | "critical" | "unknown";

const clampPct = (v: number | null | undefined) =>
  v == null ? null : Math.min(Math.max(v, 0), 100);

function rangeFromPreset(preset: Preset, custom: { from?: Date; to?: Date }) {
  const now = new Date();
  if (preset === "today") return { start: startOfDay(now), end: endOfDay(now) };
  if (preset === "24h") return { start: new Date(now.getTime() - 24 * 60 * 60 * 1000), end: now };
  if (preset === "7d") return { start: subDays(now, 7), end: now };
  return {
    start: custom.from ? startOfDay(custom.from) : subDays(now, 1),
    end: custom.to ? endOfDay(custom.to) : now,
  };
}

// Health classification per metric
function deliveryHealth(v: number | null): Health {
  if (v == null) return "unknown";
  if (v >= 98) return "healthy";
  if (v >= 95) return "warning";
  return "critical";
}
function acceptanceHealth(v: number | null): Health {
  if (v == null) return "unknown";
  if (v >= 70) return "healthy";
  if (v >= 40) return "warning";
  return "critical";
}
function timeoutHealth(v: number | null): Health {
  if (v == null) return "unknown";
  if (v < 15) return "healthy";
  if (v <= 30) return "warning";
  return "critical";
}
function fallbackHealth(v: number | null): Health {
  if (v == null) return "unknown";
  if (v < 5) return "healthy";
  if (v <= 15) return "warning";
  return "critical";
}
function noEligibleHealth(v: number | null): Health {
  if (v == null) return "unknown";
  if (v < 10) return "healthy";
  if (v <= 25) return "warning";
  return "critical";
}
function pushHealth(
  data: DispatchMetricsResult | undefined,
  socketHealth: Health,
  deliveryHealthState: Health,
): Health {
  if (!data || data.push_enqueued === 0) return "unknown";
  const eligible = Math.max(data.push_enqueued - (data.push_skip_no_token ?? 0), 0);
  if (eligible === 0) return "unknown";

  if (data.push_success_rate == null && data.push_failed === 0) {
    if (socketHealth === "healthy" && (deliveryHealthState === "healthy" || deliveryHealthState === "warning")) {
      return "warning";
    }
    return "unknown";
  }

  return deliveryHealth(data.push_success_rate ?? null);
}

const HEALTH_TEXT: Record<string, Record<Health, string>> = {
  delivery: {
    healthy: "Delivery system healthy. Ride offers are reliably reaching drivers.",
    warning: "Some ride offers are delayed or missing. Check push delivery, realtime sockets, and fallback recovery.",
    critical: "Delivery reliability is degraded. Drivers may not receive ride offers consistently. Inspect push_failed, socket_failed, and booking_received gaps.",
    unknown: "No offer delivery activity in this window.",
  },
  acceptance: {
    healthy: "Drivers are accepting most delivered offers.",
    warning: "Acceptance rate is moderate. Pricing, distance, or driver preferences may be reducing acceptance.",
    critical: "Low acceptance rate. Drivers are receiving offers but frequently ignoring or rejecting them.",
    unknown: "No offers in this window to evaluate acceptance.",
  },
  timeout: {
    healthy: "Drivers are responding quickly to offers.",
    warning: "Some drivers are not responding before expiry.",
    critical: "Many offers expire without driver response. Consider longer expiry windows or improved alert visibility.",
    unknown: "No offers in this window.",
  },
  fallback: {
    healthy: "Offers are reaching drivers without needing pending-offers recovery.",
    warning: "Some offers were only surfaced after pending-offers poll recovery.",
    critical: "Many offers needed pending-offers recovery before the driver saw them — check realtime/socket health.",
    unknown: "No offer activity in this window.",
  },
  push: {
    healthy: "FCM/APNs native alerts are confirming delivery for enqueued offers.",
    warning: "FCM confirmation is partial or unlogged; drivers may still receive offers via realtime socket.",
    critical: "FCM push delivery is failing for many enqueued offers.",
    unknown: "No FCM push attempts in this window, or outcomes are not yet logged.",
  },
  socket: {
    healthy: "Realtime socket delivery is reaching drivers for nearly all offers.",
    warning: "Some offers did not log socket delivery.",
    critical: "Socket delivery is missing for many offers — check driver presence and realtime channels.",
    unknown: "No offer activity in this window.",
  },
  noEligible: {
    healthy: "Driver availability is healthy.",
    warning: "Some trips cannot find eligible drivers. Review online presence, service area coverage, and filters.",
    critical: "Many trips have no eligible drivers. Dispatch eligibility or driver availability may be too restrictive.",
    unknown: "No dispatch eligibility evaluations in this window.",
  },
};

const HEALTH_STYLE: Record<Health, { card: string; badge: string; icon: JSX.Element; label: string }> = {
  healthy: {
    card: "border-emerald-500/30",
    badge: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30",
    icon: <CheckCircle2 className="h-3.5 w-3.5" />,
    label: "Healthy",
  },
  warning: {
    card: "border-amber-500/40",
    badge: "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30",
    icon: <AlertCircle className="h-3.5 w-3.5" />,
    label: "Warning",
  },
  critical: {
    card: "border-destructive/50",
    badge: "bg-destructive/15 text-destructive border-destructive/40",
    icon: <XCircle className="h-3.5 w-3.5" />,
    label: "Critical",
  },
  unknown: {
    card: "border-border",
    badge: "bg-muted text-muted-foreground border-border",
    icon: <AlertCircle className="h-3.5 w-3.5" />,
    label: "No data",
  },
};

export default function DispatchMetrics() {
  const [preset, setPreset] = useState<Preset>("24h");
  const [customRange, setCustomRange] = useState<{ from?: Date; to?: Date }>({});
  const [regionId, setRegionId] = useState<string>("all");
  const [serviceAreaId, setServiceAreaId] = useState<string>("all");
  const [driverId, setDriverId] = useState<string>("");

  const { data: regions = [] } = useRegions();
  const { data: serviceAreas = [] } = useServiceAreas({ activeOnly: true });
  const { start, end } = useMemo(() => rangeFromPreset(preset, customRange), [preset, customRange]);

  const { data, isLoading, refetch, isFetching, error } = useQuery({
    queryKey: ["dispatch-metrics", start.toISOString(), end.toISOString(), regionId, serviceAreaId, driverId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_dispatch_metrics", {
        p_start: start.toISOString(),
        p_end: end.toISOString(),
        p_region_id: regionId === "all" ? null : regionId,
        p_service_area_id: serviceAreaId === "all" ? null : serviceAreaId,
        p_driver_id: driverId.trim() ? driverId.trim() : null,
      });
      if (error) throw error;
      return data as unknown as DispatchMetricsResult;
    },
  });

  const filteredServiceAreas = regionId === "all" ? serviceAreas : serviceAreas.filter((s) => s.region_id === regionId);

  // Derived health states
  const hDelivery = deliveryHealth(data?.ack_success_rate ?? null);
  const hSocket = deliveryHealth(data?.socket_success_rate ?? null);
  const hAcceptance = acceptanceHealth(data?.acceptance_rate ?? null);
  const hTimeout = timeoutHealth(data?.timeout_rate ?? null);
  const hFallback = fallbackHealth(data?.fallback_rate ?? null);
  const hNoEligible = noEligibleHealth(data?.no_eligible_rate ?? null);
  const hPush = pushHealth(data, hSocket, hDelivery);

  // Operational hints
  const hints: string[] = [];
  if (data) {
    if (hDelivery === "healthy" && (hAcceptance === "warning" || hAcceptance === "critical")) {
      hints.push("Technical delivery is healthy. This is likely a market/pricing/driver preference issue rather than a notification problem.");
    }
    if (hSocket === "healthy" && hPush === "critical") {
      hints.push("Socket/realtime delivery is healthy but FCM native alerts are failing — drivers may still see offers in-app.");
    }
    if (hPush === "warning" && hSocket === "healthy") {
      hints.push("FCM confirmation is missing or partial, but realtime/socket delivery is healthy — headline delivery is not degraded.");
    }
    if ((data.reminder_scheduler_failed ?? 0) > 0) {
      hints.push(`${data.reminder_scheduler_failed} reminder-scheduler errors logged (ride-offer-reminders). These are excluded from Push Delivery and do not block initial offer delivery.`);
    }
    if ((hFallback === "warning" || hFallback === "critical") && hSocket === "healthy") {
      hints.push("Pending-offers poll runs on app resume and is normal when the driver already received the offer via socket.");
    }
    if (hDelivery === "healthy" && (hAcceptance === "warning" || hAcceptance === "critical") && (hTimeout === "warning" || hTimeout === "critical")) {
      hints.push("Drivers are receiving offers correctly but are not accepting them.");
    }
  }

  return (
    <AdminLayout title="Dispatch Metrics" description="Real-time booking delivery health from booking_delivery_log and ride_offers.">
      {/* Filters */}
      <Card className="mb-6">
        <CardContent className="pt-6 grid gap-4 md:grid-cols-5">
          <div>
            <Label>Time range</Label>
            <Select value={preset} onValueChange={(v) => setPreset(v as Preset)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="today">Today</SelectItem>
                <SelectItem value="24h">Last 24 hours</SelectItem>
                <SelectItem value="7d">Last 7 days</SelectItem>
                <SelectItem value="custom">Custom range</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {preset === "custom" && (
            <div>
              <Label>Custom dates</Label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" className={cn("w-full justify-start text-left font-normal", !customRange.from && "text-muted-foreground")}>
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {customRange.from
                      ? customRange.to
                        ? `${format(customRange.from, "MMM d")} - ${format(customRange.to, "MMM d")}`
                        : format(customRange.from, "MMM d, yyyy")
                      : "Pick range"}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar mode="range" selected={{ from: customRange.from, to: customRange.to }}
                    onSelect={(r) => setCustomRange({ from: r?.from, to: r?.to })} initialFocus
                    className={cn("p-3 pointer-events-auto")} />
                </PopoverContent>
              </Popover>
            </div>
          )}

          <div>
            <Label>Region</Label>
            <Select value={regionId} onValueChange={(v) => { setRegionId(v); setServiceAreaId("all"); }}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All regions</SelectItem>
                {regions.map((r) => <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label>Service area</Label>
            <Select value={serviceAreaId} onValueChange={setServiceAreaId}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All service areas</SelectItem>
                {filteredServiceAreas.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label>Driver ID (optional)</Label>
            <Input value={driverId} onChange={(e) => setDriverId(e.target.value)} placeholder="UUID" />
          </div>

          <div className="flex items-end">
            <Button onClick={() => refetch()} variant="outline" disabled={isFetching}>
              <RefreshCw className={cn("h-4 w-4 mr-2", isFetching && "animate-spin")} />
              Refresh
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Operational hints */}
      {hints.length > 0 && (
        <Card className="mb-6 border-primary/30 bg-primary/5">
          <CardContent className="pt-6 space-y-2">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <ShieldAlert className="h-4 w-4 text-primary" />
              Operational guidance
            </div>
            <ul className="list-disc pl-5 space-y-1 text-sm text-muted-foreground">
              {hints.map((h, i) => <li key={i}>{h}</li>)}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* Health metric cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3 mb-6">
        <HealthCard
          title="Delivery Reliability"
          icon={<Activity className="h-4 w-4 text-primary" />}
          value={data?.ack_success_rate != null ? `${clampPct(data.ack_success_rate)}%` : "—"}
          sub={data ? `${Math.min(data.received, data.offered)} received / ${data.offered} offered` : undefined}
          health={hDelivery}
          helpText={HEALTH_TEXT.delivery[hDelivery]}
          why="Distinct offers with booking_received (or equivalent ACK) / distinct offers with booking_sent. Healthy ≥ 98%, Warning 95–97.9%, Critical < 95%."
          loading={isLoading}
        />
        <HealthCard
          title="Socket Delivery"
          icon={<Activity className="h-4 w-4 text-primary" />}
          value={data?.socket_success_rate != null ? `${clampPct(data.socket_success_rate)}%` : "—"}
          sub={data ? `${data.socket_delivered} socket / ${data.offered} offered` : undefined}
          health={hSocket}
          helpText={HEALTH_TEXT.socket[hSocket]}
          why="Distinct offers with socket_sent / distinct offers with booking_sent."
          loading={isLoading}
        />
        <HealthCard
          title="Driver Acceptance"
          icon={<CheckCircle2 className="h-4 w-4 text-primary" />}
          value={data?.acceptance_rate != null ? `${clampPct(data.acceptance_rate)}%` : "—"}
          sub={data ? `${data.accepted_offers} accepted / ${data.total_offers} offers` : undefined}
          health={hAcceptance}
          helpText={HEALTH_TEXT.acceptance[hAcceptance]}
          why="Accepted offers / total offers in ride_offers. Healthy ≥ 70%, Warning 40–69%, Critical < 40%."
          loading={isLoading}
        />
        <HealthCard
          title="Driver Timeout"
          icon={<Timer className="h-4 w-4 text-primary" />}
          value={data?.timeout_rate != null ? `${clampPct(data.timeout_rate)}%` : "—"}
          sub={data ? `${data.expired_offers} expired / ${data.total_offers} offers` : undefined}
          health={hTimeout}
          helpText={HEALTH_TEXT.timeout[hTimeout]}
          why="Expired offers (status='expired' or revoked_reason='ack_timeout') / total offers. Healthy < 15%, Warning 15–30%, Critical > 30%."
          loading={isLoading}
        />
        <HealthCard
          title="Fallback Recovery"
          icon={<RefreshCw className="h-4 w-4 text-primary" />}
          value={data?.fallback_rate != null ? `${clampPct(data.fallback_rate)}%` : "—"}
          sub={data ? `${data.fallback_offers ?? 0} offers recovered / ${data.offered} offered` : undefined}
          health={hFallback}
          helpText={HEALTH_TEXT.fallback[hFallback]}
          why="Distinct offers where pending_offers_fallback fired and the driver had not yet ACKed / distinct offers sent. Resume polling after socket delivery is excluded. Healthy < 5%, Warning 5–15%, Critical > 15%."
          loading={isLoading}
        />
        <HealthCard
          title="No Eligible Drivers"
          icon={<Users className="h-4 w-4 text-primary" />}
          value={data?.no_eligible_rate != null ? `${clampPct(data.no_eligible_rate)}%` : "—"}
          sub={data ? `${data.trips_no_eligible} of ${data.trips_evaluated} trips` : undefined}
          health={hNoEligible}
          helpText={HEALTH_TEXT.noEligible[hNoEligible]}
          why="Trips where dispatch_eligibility_log shows zero eligible drivers / trips evaluated. Healthy < 10%, Warning 10–25%, Critical > 25%."
          loading={isLoading}
        />
        <HealthCard
          title="FCM Push (native alert)"
          icon={<Send className="h-4 w-4 text-primary" />}
          value={data?.push_success_rate != null ? `${clampPct(data.push_success_rate)}%` : "—"}
          sub={data
            ? `${data.push_sent} FCM confirmed · ${data.push_failed} FCM failed · ${Math.max(data.push_enqueued - (data.push_skip_no_token ?? 0), 0)} eligible`
            : undefined}
          health={hPush}
          helpText={HEALTH_TEXT.push[hPush]}
          why="push_sent / (push_enqueued − skip_no_token). Reminder-scheduler errors from auto-dispatch are excluded. If FCM is unlogged but socket delivery is healthy, status shows Warning — not Critical."
          loading={isLoading}
        />
      </div>

      {data?.debug && (
        <Card className="mb-6">
          <CardHeader><CardTitle className="text-lg">Delivery Diagnostics</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <DebugStat label="Distinct offers reassigned or retried" value={data.debug.retry_delivery_count} />
              {(data.debug.reminder_scheduler_failed ?? data.reminder_scheduler_failed ?? 0) > 0 && (
                <DebugStat
                  label="Reminder scheduler failures (excluded from push)"
                  value={data.debug.reminder_scheduler_failed ?? data.reminder_scheduler_failed ?? 0}
                />
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Headline rates use one count per offer per phase ({data.debug.metrics_basis}). Duplicate delivery
              log rows are suppressed when offers are ACKed, recovered, or pushed more than once.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Charts */}
      <div className="grid gap-6 lg:grid-cols-2 mb-6">
        <Card>
          <CardHeader><CardTitle className="text-lg">Offered vs Received</CardTitle></CardHeader>
          <CardContent>
            <div className="h-72">
              {isLoading ? <Skeleton className="h-full w-full" /> : error ? <QueryErrorState error={error} onRetry={() => refetch()} compact /> : (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={(data?.timeline ?? []).map((t) => ({ ...t, label: format(new Date(t.bucket), "MM/dd HH:mm") }))}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                    <XAxis dataKey="label" className="text-xs" />
                    <YAxis className="text-xs" />
                    <Tooltip />
                    <Legend />
                    <Line type="monotone" dataKey="offered" stroke="hsl(var(--primary))" />
                    <Line type="monotone" dataKey="received" stroke="hsl(var(--accent-foreground))" />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-lg">Timeouts & Reassignments by Hour</CardTitle></CardHeader>
          <CardContent>
            <div className="h-72">
              {isLoading ? <Skeleton className="h-full w-full" /> : error ? <QueryErrorState error={error} onRetry={() => refetch()} compact /> : (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={(data?.hourly_failures ?? []).map((t) => ({ ...t, label: format(new Date(t.bucket), "MM/dd HH:mm") }))}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                    <XAxis dataKey="label" className="text-xs" />
                    <YAxis className="text-xs" />
                    <Tooltip />
                    <Legend />
                    <Bar dataKey="timeout" fill="hsl(var(--destructive))" />
                    <Bar dataKey="reassigned" fill="hsl(var(--primary))" />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Recent failed deliveries */}
      <Card>
        <CardHeader><CardTitle className="text-lg">Recent Failed Deliveries</CardTitle></CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Booking ID</TableHead>
                  <TableHead>Driver ID</TableHead>
                  <TableHead>Offer ID</TableHead>
                  <TableHead>Phase</TableHead>
                  <TableHead>Failure reason</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Last event</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow><TableCell colSpan={7}><Skeleton className="h-8 w-full" /></TableCell></TableRow>
                ) : error ? (
                  <TableRow><TableCell colSpan={7}><QueryErrorState error={error} onRetry={() => refetch()} compact /></TableCell></TableRow>
                ) : (data?.recent_failures ?? []).length === 0 ? (
                  <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground">No failed deliveries in this range</TableCell></TableRow>
                ) : data!.recent_failures.map((f, i) => (
                  <TableRow key={i}>
                    <TableCell className="font-mono text-xs">{f.booking_id?.slice(0, 8)}…</TableCell>
                    <TableCell className="font-mono text-xs">{f.driver_id ? `${f.driver_id.slice(0, 8)}…` : "—"}</TableCell>
                    <TableCell className="font-mono text-xs">{f.offer_id ? `${f.offer_id.slice(0, 8)}…` : "—"}</TableCell>
                    <TableCell><Badge variant="outline">{f.phase}</Badge></TableCell>
                    <TableCell className="text-sm">{f.failure_reason}</TableCell>
                    <TableCell className="text-xs">{format(new Date(f.created_at), "MMM d, HH:mm:ss")}</TableCell>
                    <TableCell className="text-xs">{format(new Date(f.last_event_at), "MMM d, HH:mm:ss")}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </AdminLayout>
  );
}

function HealthCard({
  title, value, sub, icon, health, helpText, why, loading,
}: {
  title: string; value: string; sub?: string; icon: React.ReactNode;
  health: Health; helpText: string; why: string; loading?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const style = HEALTH_STYLE[health];
  return (
    <Card className={cn("border-2", style.card)}>
      <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
        <div className="flex items-center gap-2">
          {icon}
          <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
        </div>
        <Badge variant="outline" className={cn("flex items-center gap-1 text-xs", style.badge)}>
          {style.icon}
          {style.label}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-2">
        {loading ? <Skeleton className="h-8 w-24" /> : <div className="text-2xl font-bold">{value}</div>}
        {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
        <p className="text-xs text-foreground/80 leading-relaxed">{helpText}</p>
        <Collapsible open={open} onOpenChange={setOpen}>
          <CollapsibleTrigger asChild>
            <button type="button" className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
              Why?
              <ChevronDown className={cn("h-3 w-3 transition-transform", open && "rotate-180")} />
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2 text-xs text-muted-foreground border-t border-border/50 pt-2">
            {why}
          </CollapsibleContent>
        </Collapsible>
      </CardContent>
    </Card>
  );
}

function DebugStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-xl font-semibold mt-1">{value}</div>
    </div>
  );
}
