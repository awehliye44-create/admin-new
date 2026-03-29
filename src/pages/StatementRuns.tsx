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
import { Progress } from "@/components/ui/progress";
import { toast } from "@/hooks/use-toast";
import { format, startOfMonth, endOfMonth, subMonths } from "date-fns";
import { Play, Clock, CheckCircle, Send, FileText, AlertTriangle, Loader2 } from "lucide-react";

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

  // Default to previous month
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
        .select("*, regions(name, currency_code)")
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return data;
    },
  });

  // Create a new statement run and generate invoices for all eligible drivers
  const createRunMutation = useMutation({
    mutationFn: async () => {
      if (!selectedRegion) throw new Error("Select a region");

      const region = regions.find(r => r.id === selectedRegion);
      if (!region?.currency_code) throw new Error("Region has no currency configured");

      // Create the run record
      const { data: run, error: runError } = await supabase
        .from("statement_runs")
        .insert({
          period_start: periodStart,
          period_end: periodEnd,
          region_id: selectedRegion,
          service_area_id: selectedServiceArea || null,
          currency_code: region.currency_code,
          status: "generating",
        })
        .select()
        .single();

      if (runError) throw runError;

      // Find all drivers in this region with ledger activity in period
      let driverQuery = supabase
        .from("driver_ledger")
        .select("driver_id")
        .eq("currency_code", region.currency_code)
        .gte("created_at", periodStart)
        .lte("created_at", periodEnd + "T23:59:59Z");

      const { data: ledgerDrivers } = await driverQuery;
      const uniqueDriverIds = [...new Set((ledgerDrivers || []).map((d: any) => d.driver_id))];

      if (uniqueDriverIds.length === 0) {
        await supabase.from("statement_runs").update({ status: "completed", total_invoices: 0, completed_at: new Date().toISOString() }).eq("id", run.id);
        return { run, count: 0 };
      }

      // Get default template
      const { data: template } = await supabase
        .from("invoice_templates")
        .select("id")
        .eq("is_default", true)
        .single();

      let totalAmount = 0;
      let invoiceCount = 0;

      // Generate an invoice for each driver
      for (const driverId of uniqueDriverIds) {
        // Fetch this driver's ledger entries for the period
        const { data: entries } = await supabase
          .from("driver_ledger")
          .select("entry_type, amount_pence, trip_id")
          .eq("driver_id", driverId)
          .eq("currency_code", region.currency_code)
          .gte("created_at", periodStart)
          .lte("created_at", periodEnd + "T23:59:59Z");

        let grossEarnings = 0, commission = 0, bonuses = 0, penalties = 0, adjustments = 0, cashCollected = 0;
        let completedTrips = new Set<string>(), noShowTrips = 0, lateCancelTrips = 0;

        for (const e of entries || []) {
          const amt = e.amount_pence || 0;
          switch (e.entry_type) {
            case "TRIP_EARNING_NET": grossEarnings += amt; if (e.trip_id) completedTrips.add(e.trip_id); break;
            case "COMPANY_COMMISSION": commission += Math.abs(amt); break;
            case "BONUS": case "INCENTIVE": bonuses += amt; break;
            case "PENALTY": case "DEDUCTION": penalties += Math.abs(amt); break;
            case "ADJUSTMENT": case "REFUND": adjustments += amt; break;
            case "CASH_COLLECTION": case "CASH_COMMISSION_DEBT": cashCollected += Math.abs(amt); break;
            case "NO_SHOW_EARNING": noShowTrips++; grossEarnings += amt; break;
            case "LATE_CANCEL_EARNING": lateCancelTrips++; grossEarnings += amt; break;
            case "TIP": grossEarnings += amt; break;
          }
        }

        const netEarnings = grossEarnings - commission + bonuses - penalties + adjustments - cashCollected;

        const { data: invNum } = await supabase.rpc("generate_invoice_number");
        const invoiceNumber = invNum || `INV-${Date.now()}-${invoiceCount}`;

        const { data: inv } = await supabase
          .from("invoices")
          .insert({
            invoice_number: invoiceNumber,
            statement_run_id: run.id,
            driver_id: driverId,
            template_id: template?.id || null,
            period_start: periodStart,
            period_end: periodEnd,
            region_id: selectedRegion,
            service_area_id: selectedServiceArea || null,
            currency_code: region.currency_code,
            gross_earnings_pence: grossEarnings,
            commission_pence: commission,
            bonuses_pence: bonuses,
            penalties_pence: penalties,
            adjustments_pence: adjustments,
            cash_collected_pence: cashCollected,
            net_earnings_pence: netEarnings,
            completed_trips: completedTrips.size,
            no_show_trips: noShowTrips,
            late_cancel_trips: lateCancelTrips,
            status: "draft",
          })
          .select()
          .single();

        if (inv) {
          // Create line items
          const items: any[] = [
            { invoice_id: inv.id, item_type: "trip_earnings", description: `Completed trip earnings (${completedTrips.size} trips)`, amount_pence: grossEarnings, sort_order: 1 },
            { invoice_id: inv.id, item_type: "commission", description: "Platform commission", amount_pence: -commission, sort_order: 2 },
          ];
          if (bonuses > 0) items.push({ invoice_id: inv.id, item_type: "bonus", description: "Bonuses & incentives", amount_pence: bonuses, sort_order: 3 });
          if (penalties > 0) items.push({ invoice_id: inv.id, item_type: "penalty", description: "Penalties & deductions", amount_pence: -penalties, sort_order: 4 });
          if (adjustments !== 0) items.push({ invoice_id: inv.id, item_type: "adjustment", description: "Manual adjustments", amount_pence: adjustments, sort_order: 5 });
          if (cashCollected > 0) items.push({ invoice_id: inv.id, item_type: "cash_collected", description: "Cash collected (offset)", amount_pence: -cashCollected, sort_order: 6 });

          await supabase.from("invoice_items").insert(items);
          totalAmount += netEarnings;
          invoiceCount++;
        }
      }

      // Update the run
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

  // Send all invoices in a run
  const sendRunMutation = useMutation({
    mutationFn: async (runId: string) => {
      // Mark all draft invoices in this run as sent
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
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Statement Runs</h1>
          <p className="text-muted-foreground">Monthly batch earnings statement generation</p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Play className="h-4 w-4 mr-2" /> New Statement Run
        </Button>
      </div>

      {/* Runs Table */}
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Period</TableHead>
                <TableHead>Region</TableHead>
                <TableHead>Invoices</TableHead>
                <TableHead className="text-right">Total Amount</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow><TableCell colSpan={7} className="text-center py-8 text-muted-foreground">Loading…</TableCell></TableRow>
              ) : runs.length === 0 ? (
                <TableRow><TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
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
                      <TableCell>{run.regions?.name || "—"}</TableCell>
                      <TableCell>{run.total_invoices}</TableCell>
                      <TableCell className="text-right font-mono">
                        {formatCurrency(run.total_amount_pence / 100, run.currency_code)}
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
              <Label>Region</Label>
              <Select value={selectedRegion} onValueChange={(v) => { setSelectedRegion(v); setSelectedServiceArea(""); }}>
                <SelectTrigger><SelectValue placeholder="Select region" /></SelectTrigger>
                <SelectContent>
                  {regions.map((r) => (
                    <SelectItem key={r.id} value={r.id}>{r.name} ({r.currency_code})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {filteredServiceAreas.length > 0 && (
              <div>
                <Label>Service Area (optional)</Label>
                <Select value={selectedServiceArea} onValueChange={setSelectedServiceArea}>
                  <SelectTrigger><SelectValue placeholder="All service areas" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">All Service Areas</SelectItem>
                    {filteredServiceAreas.map((sa: any) => (
                      <SelectItem key={sa.id} value={sa.id}>{sa.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <Card className="bg-muted/50">
              <CardContent className="py-3 text-sm">
                <p className="font-medium mb-1">What this will do:</p>
                <ul className="list-disc list-inside text-muted-foreground space-y-1">
                  <li>Fetch all drivers with financial activity in the period</li>
                  <li>Calculate earnings from the driver_ledger (source of truth)</li>
                  <li>Generate individual earnings statements as drafts</li>
                  <li>You can review and send them after generation</li>
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
