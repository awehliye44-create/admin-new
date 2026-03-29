import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useRegions } from "@/hooks/useRegions";
import { useServiceAreas } from "@/hooks/useServiceAreas";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { toast } from "@/hooks/use-toast";
import { format } from "date-fns";
import {
  Calendar, Clock, Send, Globe, Settings2, CheckCircle, AlertTriangle,
  Loader2, History, Save
} from "lucide-react";

const TIMEZONES = [
  "UTC", "Europe/London", "Europe/Paris", "Europe/Berlin",
  "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles",
  "Asia/Dubai", "Asia/Kolkata", "Asia/Tokyo", "Africa/Johannesburg",
  "Africa/Lagos", "Africa/Nairobi", "Australia/Sydney",
];

const DAY_OPTIONS = Array.from({ length: 28 }, (_, i) => i + 1);

interface ScheduleConfig {
  id?: string;
  is_auto_generate_enabled: boolean;
  is_auto_send_enabled: boolean;
  frequency: string;
  generation_day: number;
  send_mode: string;
  send_day: number | null;
  send_hour: number;
  statement_period_mode: string;
  custom_period_days: number | null;
  due_days_after_generation: number;
  timezone: string;
  scope_type: string;
  scope_region_id: string | null;
  scope_service_area_id: string | null;
  last_run_at: string | null;
  last_run_status: string | null;
  last_run_error: string | null;
  last_run_invoice_count: number | null;
  next_run_at: string | null;
}

const DEFAULT_CONFIG: ScheduleConfig = {
  is_auto_generate_enabled: false,
  is_auto_send_enabled: false,
  frequency: "monthly",
  generation_day: 5,
  send_mode: "immediate",
  send_day: null,
  send_hour: 9,
  statement_period_mode: "previous_month",
  custom_period_days: null,
  due_days_after_generation: 7,
  timezone: "UTC",
  scope_type: "all",
  scope_region_id: null,
  scope_service_area_id: null,
  last_run_at: null,
  last_run_status: null,
  last_run_error: null,
  last_run_invoice_count: null,
  next_run_at: null,
};

function ordinalSuffix(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export default function StatementScheduleConfig() {
  const queryClient = useQueryClient();
  const { data: regions = [] } = useRegions();
  const { data: serviceAreas = [] } = useServiceAreas();

  const { data: savedConfig, isLoading } = useQuery({
    queryKey: ["statement-schedule-config"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("statement_schedule_configs")
        .select("*")
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data as ScheduleConfig | null;
    },
  });

  const { data: runLogs = [] } = useQuery({
    queryKey: ["statement-schedule-run-logs"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("statement_schedule_run_log")
        .select("*, regions(name), service_areas(name)")
        .order("triggered_at", { ascending: false })
        .limit(10);
      if (error) throw error;
      return data;
    },
  });

  const [config, setConfig] = useState<ScheduleConfig>(DEFAULT_CONFIG);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (savedConfig) {
      setConfig(savedConfig);
      setDirty(false);
    }
  }, [savedConfig]);

  const update = (patch: Partial<ScheduleConfig>) => {
    setConfig((prev) => ({ ...prev, ...patch }));
    setDirty(true);
  };

  const saveMutation = useMutation({
    mutationFn: async () => {
      const payload: any = {
        is_auto_generate_enabled: config.is_auto_generate_enabled,
        is_auto_send_enabled: config.is_auto_send_enabled,
        frequency: config.frequency,
        generation_day: config.generation_day,
        send_mode: config.send_mode,
        send_day: config.send_mode === "scheduled" ? config.send_day : null,
        send_hour: config.send_hour,
        statement_period_mode: config.statement_period_mode,
        custom_period_days: config.statement_period_mode === "custom" ? config.custom_period_days : null,
        due_days_after_generation: config.due_days_after_generation,
        timezone: config.timezone,
        scope_type: config.scope_type,
        scope_region_id: config.scope_type === "region" ? config.scope_region_id : null,
        scope_service_area_id: config.scope_type === "service_area" ? config.scope_service_area_id : null,
      };

      // Calculate next_run_at
      const now = new Date();
      let nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, config.generation_day, config.send_hour, 0, 0);
      if (now.getDate() < config.generation_day) {
        nextMonth = new Date(now.getFullYear(), now.getMonth(), config.generation_day, config.send_hour, 0, 0);
      }
      payload.next_run_at = config.is_auto_generate_enabled ? nextMonth.toISOString() : null;

      if (config.id) {
        const { error } = await supabase
          .from("statement_schedule_configs")
          .update(payload)
          .eq("id", config.id);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from("statement_schedule_configs")
          .insert(payload);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["statement-schedule-config"] });
      setDirty(false);
      toast({ title: "Schedule saved", description: "Statement automation settings updated" });
    },
    onError: (err: any) => {
      toast({ title: "Error saving schedule", description: err.message, variant: "destructive" });
    },
  });

  const filteredServiceAreas = config.scope_region_id
    ? serviceAreas.filter((sa: any) => sa.region_id === config.scope_region_id)
    : serviceAreas;

  if (isLoading) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin mx-auto mb-2" /> Loading schedule config…
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* Main Schedule Config */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Settings2 className="h-5 w-5" /> Statement Automation
              </CardTitle>
              <CardDescription>Configure automatic monthly statement generation and delivery</CardDescription>
            </div>
            <Button onClick={() => saveMutation.mutate()} disabled={!dirty || saveMutation.isPending}>
              {saveMutation.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
              Save Settings
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Toggles */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="flex items-center justify-between rounded-lg border border-border p-4">
              <div>
                <Label className="text-sm font-medium">Auto-Generate Statements</Label>
                <p className="text-xs text-muted-foreground mt-0.5">Automatically generate earnings statements on schedule</p>
              </div>
              <Switch
                checked={config.is_auto_generate_enabled}
                onCheckedChange={(v) => update({ is_auto_generate_enabled: v })}
              />
            </div>
            <div className="flex items-center justify-between rounded-lg border border-border p-4">
              <div>
                <Label className="text-sm font-medium">Auto-Send to Drivers</Label>
                <p className="text-xs text-muted-foreground mt-0.5">Automatically email/push statements after generation</p>
              </div>
              <Switch
                checked={config.is_auto_send_enabled}
                onCheckedChange={(v) => update({ is_auto_send_enabled: v })}
              />
            </div>
          </div>

          <Separator />

          {/* Frequency & Generation Day */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <Label className="flex items-center gap-1.5 mb-1.5">
                <Calendar className="h-3.5 w-3.5 text-muted-foreground" /> Frequency
              </Label>
              <Select value={config.frequency} onValueChange={(v) => update({ frequency: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="monthly">Monthly</SelectItem>
                  <SelectItem value="weekly">Weekly</SelectItem>
                  <SelectItem value="manual">Manual Only</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {config.frequency === "monthly" && (
              <div>
                <Label className="flex items-center gap-1.5 mb-1.5">
                  <Calendar className="h-3.5 w-3.5 text-muted-foreground" /> Generation Day
                </Label>
                <Select
                  value={String(config.generation_day)}
                  onValueChange={(v) => update({ generation_day: parseInt(v) })}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="0">Last day of month</SelectItem>
                    {DAY_OPTIONS.map((d) => (
                      <SelectItem key={d} value={String(d)}>{ordinalSuffix(d)} of month</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {config.frequency === "weekly" && (
              <div>
                <Label className="flex items-center gap-1.5 mb-1.5">
                  <Calendar className="h-3.5 w-3.5 text-muted-foreground" /> Generation Day
                </Label>
                <Select
                  value={String(config.generation_day)}
                  onValueChange={(v) => update({ generation_day: parseInt(v) })}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1">Monday</SelectItem>
                    <SelectItem value="2">Tuesday</SelectItem>
                    <SelectItem value="3">Wednesday</SelectItem>
                    <SelectItem value="4">Thursday</SelectItem>
                    <SelectItem value="5">Friday</SelectItem>
                    <SelectItem value="6">Saturday</SelectItem>
                    <SelectItem value="7">Sunday</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}

            <div>
              <Label className="flex items-center gap-1.5 mb-1.5">
                <Globe className="h-3.5 w-3.5 text-muted-foreground" /> Timezone
              </Label>
              <Select value={config.timezone} onValueChange={(v) => update({ timezone: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {TIMEZONES.map((tz) => (
                    <SelectItem key={tz} value={tz}>{tz}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <Separator />

          {/* Statement Period & Due Date */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <Label className="flex items-center gap-1.5 mb-1.5">
                <Clock className="h-3.5 w-3.5 text-muted-foreground" /> Statement Period
              </Label>
              <Select
                value={config.statement_period_mode}
                onValueChange={(v) => update({ statement_period_mode: v })}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="previous_month">Previous Calendar Month</SelectItem>
                  <SelectItem value="current_month_to_date">Current Month to Date</SelectItem>
                  <SelectItem value="custom">Custom Period (days back)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {config.statement_period_mode === "custom" && (
              <div>
                <Label className="mb-1.5">Days Back</Label>
                <Input
                  type="number"
                  min={1}
                  max={365}
                  value={config.custom_period_days || 30}
                  onChange={(e) => update({ custom_period_days: parseInt(e.target.value) || 30 })}
                />
              </div>
            )}

            <div>
              <Label className="mb-1.5">Due Date (days after generation)</Label>
              <Input
                type="number"
                min={0}
                max={90}
                value={config.due_days_after_generation}
                onChange={(e) => update({ due_days_after_generation: parseInt(e.target.value) || 7 })}
              />
            </div>
          </div>

          <Separator />

          {/* Send Timing */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <Label className="flex items-center gap-1.5 mb-1.5">
                <Send className="h-3.5 w-3.5 text-muted-foreground" /> Send Timing
              </Label>
              <Select value={config.send_mode} onValueChange={(v) => update({ send_mode: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="immediate">Immediately after generation</SelectItem>
                  <SelectItem value="scheduled">On a separate day</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {config.send_mode === "scheduled" && (
              <div>
                <Label className="mb-1.5">Send Day of Month</Label>
                <Select
                  value={String(config.send_day || 6)}
                  onValueChange={(v) => update({ send_day: parseInt(v) })}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {DAY_OPTIONS.map((d) => (
                      <SelectItem key={d} value={String(d)}>{ordinalSuffix(d)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div>
              <Label className="mb-1.5">Send Hour ({config.timezone})</Label>
              <Select
                value={String(config.send_hour)}
                onValueChange={(v) => update({ send_hour: parseInt(v) })}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Array.from({ length: 24 }, (_, i) => (
                    <SelectItem key={i} value={String(i)}>
                      {String(i).padStart(2, "0")}:00
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <Separator />

          {/* Scope */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <Label className="flex items-center gap-1.5 mb-1.5">
                <Globe className="h-3.5 w-3.5 text-muted-foreground" /> Scope
              </Label>
              <Select value={config.scope_type} onValueChange={(v) => update({ scope_type: v, scope_region_id: null, scope_service_area_id: null })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Drivers (all regions)</SelectItem>
                  <SelectItem value="region">Specific Region</SelectItem>
                  <SelectItem value="service_area">Specific Service Area</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {config.scope_type === "region" && (
              <div>
                <Label className="mb-1.5">Region</Label>
                <Select
                  value={config.scope_region_id || ""}
                  onValueChange={(v) => update({ scope_region_id: v, scope_service_area_id: null })}
                >
                  <SelectTrigger><SelectValue placeholder="Select region" /></SelectTrigger>
                  <SelectContent>
                    {regions.map((r) => (
                      <SelectItem key={r.id} value={r.id}>{r.name} ({r.currency_code})</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {config.scope_type === "service_area" && (
              <>
                <div>
                  <Label className="mb-1.5">Region</Label>
                  <Select
                    value={config.scope_region_id || ""}
                    onValueChange={(v) => update({ scope_region_id: v, scope_service_area_id: null })}
                  >
                    <SelectTrigger><SelectValue placeholder="Select region" /></SelectTrigger>
                    <SelectContent>
                      {regions.map((r) => (
                        <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {config.scope_region_id && (
                  <div>
                    <Label className="mb-1.5">Service Area</Label>
                    <Select
                      value={config.scope_service_area_id || ""}
                      onValueChange={(v) => update({ scope_service_area_id: v })}
                    >
                      <SelectTrigger><SelectValue placeholder="Select service area" /></SelectTrigger>
                      <SelectContent>
                        {filteredServiceAreas.map((sa: any) => (
                          <SelectItem key={sa.id} value={sa.id}>{sa.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </>
            )}
          </div>

          {/* Summary */}
          {config.is_auto_generate_enabled && config.frequency === "monthly" && (
            <Card className="bg-muted/50 border-primary/20">
              <CardContent className="py-3 text-sm">
                <p className="font-medium mb-1 text-primary">📋 Schedule Summary</p>
                <p className="text-muted-foreground">
                  Statements will be <strong>generated</strong> on the{" "}
                  <strong>{config.generation_day === 0 ? "last day" : ordinalSuffix(config.generation_day)}</strong> of each month
                  {" "}at <strong>{String(config.send_hour).padStart(2, "0")}:00 {config.timezone}</strong>,
                  {" "}covering the <strong>{config.statement_period_mode === "previous_month" ? "previous calendar month" : config.statement_period_mode === "current_month_to_date" ? "current month to date" : `last ${config.custom_period_days} days`}</strong>.
                  {config.is_auto_send_enabled && (
                    <> They will be <strong>sent to drivers</strong>{" "}
                      {config.send_mode === "immediate" ? "immediately after generation" : `on the ${ordinalSuffix(config.send_day || 6)}`}.
                    </>
                  )}
                  {" "}Due date: <strong>{config.due_days_after_generation} days</strong> after generation.
                  {" "}Scope: <strong>{config.scope_type === "all" ? "All regions" : config.scope_type === "region" ? "Specific region" : "Specific service area"}</strong>.
                </p>
              </CardContent>
            </Card>
          )}
        </CardContent>
      </Card>

      {/* Run Status */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardContent className="py-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
              <Calendar className="h-4 w-4" /> Next Scheduled Run
            </div>
            <p className="font-medium text-foreground">
              {config.next_run_at
                ? format(new Date(config.next_run_at), "dd MMM yyyy 'at' HH:mm")
                : "Not scheduled"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
              <CheckCircle className="h-4 w-4" /> Last Successful Run
            </div>
            <p className="font-medium text-foreground">
              {config.last_run_status === "success" && config.last_run_at
                ? `${format(new Date(config.last_run_at), "dd MMM yyyy HH:mm")} — ${config.last_run_invoice_count} invoices`
                : "No successful run yet"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
              <AlertTriangle className="h-4 w-4" /> Last Failed Run
            </div>
            <p className="font-medium text-foreground">
              {config.last_run_status === "failed" && config.last_run_at
                ? format(new Date(config.last_run_at), "dd MMM yyyy HH:mm")
                : "No failures"}
            </p>
            {config.last_run_status === "failed" && config.last_run_error && (
              <p className="text-xs text-destructive mt-1">{config.last_run_error}</p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Run History */}
      {runLogs.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <History className="h-4 w-4" /> Scheduled Run History
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="divide-y divide-border">
              {runLogs.map((log: any) => (
                <div key={log.id} className="flex items-center justify-between px-4 py-3 text-sm">
                  <div className="flex items-center gap-3">
                    <Badge variant={log.status === "success" ? "default" : log.status === "failed" ? "destructive" : "secondary"}>
                      {log.status}
                    </Badge>
                    <span className="text-muted-foreground">
                      {log.period_start && log.period_end
                        ? `${format(new Date(log.period_start), "dd MMM")} – ${format(new Date(log.period_end), "dd MMM yyyy")}`
                        : "—"}
                    </span>
                    {log.regions?.name && (
                      <span className="text-xs text-muted-foreground">({log.regions.name})</span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 text-muted-foreground">
                    <span>{log.invoice_count ?? 0} invoices</span>
                    <span>{format(new Date(log.triggered_at), "dd MMM yyyy HH:mm")}</span>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
