import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useRegions } from "@/hooks/useRegions";
import { useServiceAreas } from "@/hooks/useServiceAreas";
import { formatCurrency } from "@/lib/regionSettings";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "@/hooks/use-toast";
import { format, startOfMonth, endOfMonth, subMonths } from "date-fns";
import { Play, Clock, CheckCircle, Send, FileText, AlertTriangle, Loader2, Globe, Settings2 } from "lucide-react";
import StatementScheduleConfig from "@/components/statements/StatementScheduleConfig";
import { fetchDriverStatementPeriodTotals } from "@/hooks/financeReconciliationApi";
import { FinanceSsotOperationalNotice } from "@/components/finance/FinanceSSOTBadge";

const RUN_STATUS: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline"; icon: any }> = {
  draft: { label: "Draft", variant: "secondary", icon: Clock },
  generating: { label: "Generating", variant: "outline", icon: Loader2 },
  completed: { label: "Completed", variant: "default", icon: CheckCircle },
  sending: { label: "Sending", variant: "outline", icon: Send },
  sent: { label: "Sent", variant: "default", icon: CheckCircle },
  failed: { label: "Failed", variant: "destructive", icon: AlertTriangle },
};

export default function StatementRuns() {
  const queryClient = useQueryClient();
  const { data: regions = [] } = useRegions();
  const { data: serviceAreas = [] } = useServiceAreas();
  const [createOpen, setCreateOpen] = useState(false);

  const prevMonth = subMonths(new Date(), 1);
  const [periodStart, setPeriodStart] = useState(format(startOfMonth(prevMonth), "yyyy-MM-dd"));
  const [periodEnd, setPeriodEnd] = useState(format(endOfMonth(prevMonth), "yyyy-MM-dd"));
  const [selectedRegion, setSelectedRegion] = useState("");
  const [selectedServiceArea, setSelectedServiceArea] = useState("");

  const { data: runs = [], isLoading } = useQuery({
    queryKey: ["statement-runs"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("statement_runs")
        .select("*, regions(name, currency_code), service_areas(name)")
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return data;
    },
  });

  const createRunMutation = useMutation({
    mutationFn: async () => {
      if (!selectedRegion) throw new Error("Select a region");

      const region = regions.find(r => r.id === selectedRegion);
      if (!region?.currency_code) throw new Error("Region has no currency configured");

      const saId = selectedServiceArea && selectedServiceArea !== "all" ? selectedServiceArea : null;

      // Create the run record
      const { data: run, error: runError } = await supabase
        .from("statement_runs")
        .insert({
          period_start: periodStart,
          period_end: periodEnd,
          region_id: selectedRegion,
          service_area_id: saId,
          currency_code: region.currency_code,
          status: "generating",
        })
        .select()
        .single();

      if (runError) throw runError;

      // Find drivers with ledger activity in this region's currency for this period (SSOT: driver_wallet_ledger)
      let driverQuery = supabase
        .from("driver_wallet_ledger")
        .select("driver_id")
        .eq("currency", region.currency_code)
        .gte("created_at", periodStart)
        .lte("created_at", periodEnd + "T23:59:59Z");

      const { data: ledgerDrivers } = await driverQuery;
      let uniqueDriverIds = [...new Set((ledgerDrivers || []).map((d: any) => d.driver_id))];

      // If specific service area selected, filter to drivers assigned to it
      if (saId) {
        const { data: saDrivers } = await supabase
          .from("driver_service_areas")
          .select("driver_id")
          .eq("service_area_id", saId);
        const saDriverSet = new Set((saDrivers || []).map((d: any) => d.driver_id));
        uniqueDriverIds = uniqueDriverIds.filter(id => saDriverSet.has(id));
      }

      if (uniqueDriverIds.length === 0) {
        await supabase.from("statement_runs").update({
          status: "completed",
          total_invoices: 0,
          total_amount_pence: 0,
          completed_at: new Date().toISOString(),
        }).eq("id", run.id);
        return { run, count: 0 };
      }

      const statementTotals = await fetchDriverStatementPeriodTotals(
        { regionId: selectedRegion, serviceAreaId: saId, currencyCode: null },
        `${periodStart}T00:00:00.000Z`,
        `${periodEnd}T23:59:59.999Z`,
        uniqueDriverIds,
      );
      const totalsByDriver = new Map(statementTotals.map((t) => [t.driver_id, t]));

      const { data: template } = await supabase
        .from("invoice_templates")
        .select("id")
        .eq("is_default", true)
        .single();

      let totalAmount = 0;
      let invoiceCount = 0;

      for (const driverId of uniqueDriverIds) {
        const totals = totalsByDriver.get(driverId);
        if (!totals) continue;

        const grossEarnings = totals.gross_earnings_pence;
        const commission = totals.commission_pence;
        const bonuses = totals.bonuses_pence;
        const penalties = totals.penalties_pence;
        const adjustments = totals.adjustments_pence;
        const completedTrips = totals.completed_trips;
        const noShowTrips = totals.no_show_trips;
        const lateCancelTrips = totals.late_cancel_trips;
        const netEarnings = totals.net_earnings_pence;

        if (netEarnings === 0 && grossEarnings === 0 && commission === 0 && bonuses === 0 && penalties === 0 && adjustments === 0) {
          continue;
        }

        const { data: invNum } = await supabase.rpc("generate_invoice_number");
        const invoiceNumber = invNum || `INV-${Date.now()}-${invoiceCount}`;

        const { data: driverRow } = await supabase
          .from("drivers")
          .select("first_name, last_name, driver_code, email")
          .eq("id", driverId)
          .maybeSingle();
        const driverDisplayName = driverRow
          ? `${driverRow.first_name ?? ""} ${driverRow.last_name ?? ""}`.trim()
          : "";

        const { data: inv } = await supabase
          .from("invoices")
          .insert({
            invoice_number: invoiceNumber,
            statement_run_id: run.id,
            driver_id: driverId,
            driver_display_name: driverDisplayName || null,
            driver_display_code: driverRow?.driver_code ?? null,
            driver_display_email: driverRow?.email ?? null,
            template_id: template?.id || null,
            period_start: periodStart,
            period_end: periodEnd,
            region_id: selectedRegion,
            service_area_id: saId,
            currency_code: region.currency_code,
            gross_earnings_pence: grossEarnings,
            commission_pence: commission,
            bonuses_pence: bonuses,
            penalties_pence: penalties,
            adjustments_pence: adjustments,
            cash_collected_pence: 0,
            net_earnings_pence: netEarnings,
            completed_trips: completedTrips,
            no_show_trips: noShowTrips,
            late_cancel_trips: lateCancelTrips,
            status: "draft",
          })
          .select()
          .single();

        if (inv) {
          const items: any[] = [
            { invoice_id: inv.id, item_type: "trip_earnings", description: `Completed trip earnings (${completedTrips} trips)`, amount_pence: grossEarnings, sort_order: 1 },
            { invoice_id: inv.id, item_type: "commission", description: "Platform commission", amount_pence: -commission, sort_order: 2 },
          ];
          if (bonuses > 0) items.push({ invoice_id: inv.id, item_type: "bonus", description: "Bonuses & incentives", amount_pence: bonuses, sort_order: 3 });
          if (penalties > 0) items.push({ invoice_id: inv.id, item_type: "penalty", description: "Penalties & deductions", amount_pence: -penalties, sort_order: 4 });
          if (adjustments !== 0) items.push({ invoice_id: inv.id, item_type: "adjustment", description: "Manual adjustments", amount_pence: adjustments, sort_order: 5 });

          await supabase.from("invoice_items").insert(items);
          totalAmount += netEarnings;
          invoiceCount++;
        }
      }

      await supabase
        .from("statement_runs")
        .update({
          status: "completed",
          total_invoices: invoiceCount,
          total_amount_pence: totalAmount,
          completed_at: new Date().toISOString(),
        })
        .eq("id", run.id);

      return { run, count: invoiceCount };
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["statement-runs"] });
      queryClient.invalidateQueries({ queryKey: ["invoices"] });
      setCreateOpen(false);
      toast({
        title: "Statement run completed",
        description: `Generated ${result.count} earnings statements`,
      });
    },
    onError: (err: any) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const sendRunMutation = useMutation({
    mutationFn: async (runId: string) => {
      const { error } = await supabase
        .from("invoices")
        .update({ status: "sent", sent_at: new Date().toISOString(), finalized_at: new Date().toISOString() })
        .eq("statement_run_id", runId)
        .eq("status", "draft");
      if (error) throw error;

      await supabase
        .from("statement_runs")
        .update({ status: "sent" })
        .eq("id", runId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["statement-runs"] });
      queryClient.invalidateQueries({ queryKey: ["invoices"] });
      toast({ title: "All statements sent" });
    },
  });

  const filteredServiceAreas = selectedRegion
    ? serviceAreas.filter((sa: any) => sa.region_id === selectedRegion)
    : serviceAreas;

  return (
    <div className="space-y-6">
      <FinanceSsotOperationalNotice />
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Statement Runs</h1>
          <p className="text-muted-foreground">Monthly batch earnings statement generation — per region</p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Play className="h-4 w-4 mr-2" /> New Statement Run
        </Button>
      </div>

      <Tabs defaultValue="runs" className="space-y-4">
        <TabsList>
          <TabsTrigger value="runs"><FileText className="h-4 w-4 mr-1.5" /> Statement Runs</TabsTrigger>
          <TabsTrigger value="schedule"><Settings2 className="h-4 w-4 mr-1.5" /> Automation</TabsTrigger>
        </TabsList>

        <TabsContent value="runs" className="space-y-4">

      {/* Runs Table */}
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Period</TableHead>
                <TableHead>Region</TableHead>
                <TableHead>Service Area</TableHead>
                <TableHead>Invoices</TableHead>
                <TableHead className="text-right">Total Amount</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow><TableCell colSpan={8} className="text-center py-8 text-muted-foreground">Loading…</TableCell></TableRow>
              ) : runs.length === 0 ? (
                <TableRow><TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                  <FileText className="h-8 w-8 mx-auto mb-2 opacity-40" />
                  No statement runs yet. Start your first monthly run.
                </TableCell></TableRow>
              ) : (
                runs.map((run: any) => {
                  const status = RUN_STATUS[run.status] || RUN_STATUS.draft;
                  const Icon = status.icon;
                  return (
                    <TableRow key={run.id}>
                      <TableCell className="font-medium">
                        {format(new Date(run.period_start), "dd MMM")} – {format(new Date(run.period_end), "dd MMM yyyy")}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1.5">
                          <Globe className="h-3.5 w-3.5 text-muted-foreground" />
                          {run.regions?.name || "—"}
                        </div>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {run.service_areas?.name || "All"}
                      </TableCell>
                      <TableCell>{run.total_invoices}</TableCell>
                      <TableCell className="text-right font-mono">
                        {formatCurrency((run.total_amount_pence || 0) / 100, run.currency_code)}
                      </TableCell>
                      <TableCell>
                        <Badge variant={status.variant} className="gap-1">
                          <Icon className="h-3 w-3" /> {status.label}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {format(new Date(run.created_at), "dd MMM yyyy HH:mm")}
                      </TableCell>
                      <TableCell className="text-right">
                        {run.status === "completed" && (
                          <Button size="sm" variant="outline" onClick={() => sendRunMutation.mutate(run.id)}>
                            <Send className="h-3.5 w-3.5 mr-1" /> Send All
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
        </TabsContent>

        <TabsContent value="schedule">
          <StatementScheduleConfig />
        </TabsContent>
      </Tabs>

      {/* Create Run Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>New Monthly Statement Run</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Period Start</Label>
                <Input type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} />
              </div>
              <div>
                <Label>Period End</Label>
                <Input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} />
              </div>
            </div>
            <div>
              <Label>Region (determines currency for all invoices)</Label>
              <Select value={selectedRegion} onValueChange={(v) => { setSelectedRegion(v); setSelectedServiceArea(""); }}>
                <SelectTrigger><SelectValue placeholder="Select region" /></SelectTrigger>
                <SelectContent>
                  {regions.map((r) => (
                    <SelectItem key={r.id} value={r.id}>{r.name} ({r.currency_code})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selectedRegion && (
                <p className="text-xs text-muted-foreground mt-1">
                  All invoices will use <strong>{regions.find(r => r.id === selectedRegion)?.currency_code}</strong>
                </p>
              )}
            </div>
            {filteredServiceAreas.length > 0 && (
              <div>
                <Label>Service Area (optional)</Label>
                <Select value={selectedServiceArea} onValueChange={setSelectedServiceArea}>
                  <SelectTrigger><SelectValue placeholder="All service areas" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Service Areas</SelectItem>
                    {filteredServiceAreas.map((sa: any) => (
                      <SelectItem key={sa.id} value={sa.id}>{sa.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <Card className="bg-muted/50">
              <CardContent className="py-3 text-sm">
                <p className="font-medium mb-1">Region-based generation rules:</p>
                <ul className="list-disc list-inside text-muted-foreground space-y-1">
                  <li>Fetch all drivers with financial activity in the selected region's currency</li>
                  <li>Only ledger entries matching the region currency are included</li>
                  <li>No mixed currencies — one invoice = one region = one currency</li>
                  <li>For multi-region drivers, run separate statement runs per region</li>
                  <li>Invoices are generated as drafts — review and send after</li>
                </ul>
              </CardContent>
            </Card>

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
              <Button
                onClick={() => createRunMutation.mutate()}
                disabled={createRunMutation.isPending || !selectedRegion}
              >
                {createRunMutation.isPending ? (
                  <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Generating…</>
                ) : (
                  <><Play className="h-4 w-4 mr-2" /> Start Run</>
                )}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
