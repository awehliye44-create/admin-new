import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { format, subDays, startOfDay, endOfDay } from "date-fns";
import { CalendarIcon, Activity, Send, Timer, RefreshCw } from "lucide-react";
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
import { QueryErrorState } from "@/components/QueryErrorState";
import { cn } from "@/lib/utils";
import { useRegions } from "@/hooks/useRegions";
import { useServiceAreas } from "@/hooks/useServiceAreas";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";

type Preset = "today" | "24h" | "7d" | "custom";

interface DispatchMetricsResult {
  offered: number;
  received: number;
  ack_success_rate: number | null;
  push_enqueued: number;
  push_sent: number;
  push_success_rate: number | null;
  avg_accept_seconds: number;
  total_offers: number;
  reassigned_offers: number;
  reassigned_pct: number | null;
  timeline: Array<{ bucket: string; offered: number; received: number }>;
  hourly_failures: Array<{ bucket: string; timeout: number; reassigned: number }>;
  recent_failures: Array<{
    booking_id: string;
    driver_id: string | null;
    offer_id: string | null;
    phase: string;
    failure_reason: string;
    created_at: string;
    last_event_at: string;
  }>;
  debug?: {
    duplicate_ack_count: number;
    duplicate_push_count: number;
    retry_delivery_count: number;
    pending_offer_recovery_count: number;
  };
}

const clampPct = (v: number | null | undefined) =>
  v == null ? null : Math.min(Math.max(v, 0), 100);

function rangeFromPreset(preset: Preset, custom: { from?: Date; to?: Date }): { start: Date; end: Date } {
  const now = new Date();
  if (preset === "today") return { start: startOfDay(now), end: endOfDay(now) };
  if (preset === "24h") return { start: new Date(now.getTime() - 24 * 60 * 60 * 1000), end: now };
  if (preset === "7d") return { start: subDays(now, 7), end: now };
  return {
    start: custom.from ? startOfDay(custom.from) : subDays(now, 1),
    end: custom.to ? endOfDay(custom.to) : now,
  };
}

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
                  <Calendar
                    mode="range"
                    selected={{ from: customRange.from, to: customRange.to }}
                    onSelect={(r) => setCustomRange({ from: r?.from, to: r?.to })}
                    initialFocus
                    className={cn("p-3 pointer-events-auto")}
                  />
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

      {/* Metric cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4 mb-6">
        <MetricCard
          title="ACK Success Rate"
          icon={<Activity className="h-4 w-4 text-primary" />}
          value={data?.ack_success_rate != null ? `${data.ack_success_rate}%` : "—"}
          sub={data ? `${data.received} received / ${data.offered} offered` : undefined}
          loading={isLoading}
        />
        <MetricCard
          title="Push Success Rate"
          icon={<Send className="h-4 w-4 text-primary" />}
          value={data?.push_success_rate != null ? `${data.push_success_rate}%` : "—"}
          sub={data ? `${data.push_sent} sent / ${data.push_enqueued} enqueued` : undefined}
          loading={isLoading}
        />
        <MetricCard
          title="Average Accept Time"
          icon={<Timer className="h-4 w-4 text-primary" />}
          value={data ? `${data.avg_accept_seconds.toFixed(1)}s` : "—"}
          sub="Time from offered → accepted"
          loading={isLoading}
        />
        <MetricCard
          title="Reassigned Booking %"
          icon={<RefreshCw className="h-4 w-4 text-primary" />}
          value={data?.reassigned_pct != null ? `${data.reassigned_pct}%` : "—"}
          sub={data ? `${data.reassigned_offers} of ${data.total_offers} offers` : undefined}
          loading={isLoading}
        />
      </div>

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

function MetricCard({ title, value, sub, icon, loading }: { title: string; value: string; sub?: string; icon: React.ReactNode; loading?: boolean }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
        {icon}
      </CardHeader>
      <CardContent>
        {loading ? <Skeleton className="h-8 w-24" /> : <div className="text-2xl font-bold">{value}</div>}
        {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
      </CardContent>
    </Card>
  );
}
