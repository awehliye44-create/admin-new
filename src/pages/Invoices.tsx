import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useRegions } from "@/hooks/useRegions";
import { useServiceAreas } from "@/hooks/useServiceAreas";
import { getCurrencySymbol, formatCurrency } from "@/lib/regionSettings";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Separator } from "@/components/ui/separator";
import { toast } from "@/hooks/use-toast";
import { format } from "date-fns";
import {
  FileText, Send, Eye, RefreshCw, Search, Filter, Download,
  CheckCircle, Clock, Mail, XCircle, Plus, Globe, MapPin
} from "lucide-react";

const STATUS_CONFIG: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  draft: { label: "Draft", variant: "secondary" },
  finalized: { label: "Finalized", variant: "outline" },
  sent: { label: "Sent", variant: "default" },
  viewed: { label: "Viewed", variant: "default" },
  cancelled: { label: "Cancelled", variant: "destructive" },
};

interface Invoice {
  id: string;
  invoice_number: string;
  driver_id: string;
  period_start: string;
  period_end: string;
  currency_code: string;
  gross_earnings_pence: number;
  commission_pence: number;
  bonuses_pence: number;
  penalties_pence: number;
  adjustments_pence: number;
  cash_collected_pence: number;
  net_earnings_pence: number;
  completed_trips: number;
  no_show_trips: number;
  late_cancel_trips: number;
  status: string;
  pdf_storage_path: string | null;
  created_at: string;
  sent_at: string | null;
  viewed_at: string | null;
  region_id: string;
  service_area_id: string | null;
  statement_run_id: string | null;
  drivers?: { first_name: string; last_name: string; driver_code: string } | null;
  regions?: { name: string; currency_code: string } | null;
  service_areas?: { name: string } | null;
}

export default function Invoices() {
  const queryClient = useQueryClient();
  const { data: regions = [] } = useRegions();
  const { data: serviceAreas = [] } = useServiceAreas();
  const [statusFilter, setStatusFilter] = useState("all");
  const [regionFilter, setRegionFilter] = useState("all");
  const [serviceAreaFilter, setServiceAreaFilter] = useState("all");
  const [searchTerm, setSearchTerm] = useState("");
  const [previewInvoice, setPreviewInvoice] = useState<Invoice | null>(null);
  const [previewItems, setPreviewItems] = useState<any[]>([]);
  const [generateOpen, setGenerateOpen] = useState(false);

  // Generate form state
  const [genRegion, setGenRegion] = useState("");
  const [genServiceArea, setGenServiceArea] = useState("");
  const [genPeriodStart, setGenPeriodStart] = useState("");
  const [genPeriodEnd, setGenPeriodEnd] = useState("");
  const [genDriverSearch, setGenDriverSearch] = useState("");
  const [selectedDriverId, setSelectedDriverId] = useState<string | null>(null);

  const { data: invoices = [], isLoading } = useQuery({
    queryKey: ["invoices", statusFilter, regionFilter, serviceAreaFilter],
    queryFn: async () => {
      let query = supabase
        .from("invoices")
        .select("*, drivers(first_name, last_name, driver_code), regions(name, currency_code), service_areas(name)")
        .order("created_at", { ascending: false })
        .limit(200);

      if (statusFilter !== "all") query = query.eq("status", statusFilter);
      if (regionFilter !== "all") query = query.eq("region_id", regionFilter);
      if (serviceAreaFilter !== "all") query = query.eq("service_area_id", serviceAreaFilter);

      const { data, error } = await query;
      if (error) throw error;
      return data as Invoice[];
    },
  });

  const filteredInvoices = useMemo(() => {
    if (!searchTerm) return invoices;
    const term = searchTerm.toLowerCase();
    return invoices.filter(
      (inv) =>
        inv.invoice_number.toLowerCase().includes(term) ||
        inv.drivers?.first_name?.toLowerCase().includes(term) ||
        inv.drivers?.last_name?.toLowerCase().includes(term) ||
        inv.drivers?.driver_code?.toLowerCase().includes(term)
    );
  }, [invoices, searchTerm]);

  // Group totals by currency to prevent mixed-currency aggregation
  const currencyGroupedTotals = useMemo(() => {
    const groups: Record<string, { count: number; totalNet: number; drafts: number; sent: number }> = {};
    for (const inv of invoices) {
      const cc = inv.currency_code;
      if (!groups[cc]) groups[cc] = { count: 0, totalNet: 0, drafts: 0, sent: 0 };
      groups[cc].count++;
      groups[cc].totalNet += inv.net_earnings_pence;
      if (inv.status === "draft") groups[cc].drafts++;
      if (inv.status === "sent") groups[cc].sent++;
    }
    return groups;
  }, [invoices]);

  // Generate single invoice
  const generateMutation = useMutation({
    mutationFn: async (params: { driverId: string; periodStart: string; periodEnd: string; regionId: string; serviceAreaId?: string }) => {
      const region = regions.find(r => r.id === params.regionId);
      if (!region?.currency_code) throw new Error("Region has no currency configured");

      // Fetch driver financial data from driver_wallet_ledger (SSOT)
      const { data: ledgerData, error: ledgerError } = await supabase
        .from("driver_wallet_ledger")
        .select("type, amount_pence, currency, description, related_trip_id")
        .eq("driver_id", params.driverId)
        .eq("currency", region.currency_code)
        .gte("created_at", params.periodStart)
        .lte("created_at", params.periodEnd + "T23:59:59Z");

      if (ledgerError) throw ledgerError;

      // Aggregate by entry type
      let grossEarnings = 0, commission = 0, bonuses = 0, penalties = 0, adjustments = 0, cashCollected = 0;
      let completedTrips = new Set<string>(), noShowTrips = 0, lateCancelTrips = 0;

      for (const entry of ledgerData || []) {
        const amt = entry.amount_pence || 0;
        switch (entry.type) {
          case "TRIP_EARNING_NET":
            grossEarnings += amt;
            if (entry.related_trip_id) completedTrips.add(entry.related_trip_id);
            break;
          case "PLATFORM_COMMISSION":
            commission += Math.abs(amt);
            break;
          case "BONUS":
            bonuses += amt;
            break;
          case "ADJUSTMENT": case "REFUND_DEBIT":
            adjustments += amt;
            break;
          case "CASH_COMMISSION_DEBT":
            cashCollected += Math.abs(amt);
            break;
          case "CASH_TRIP_EARNING":
            // Cash gross — count as a completed trip
            if (entry.related_trip_id) completedTrips.add(entry.related_trip_id);
            break;
          case "TIP_CREDIT": case "DRIVER_TIP_CREDIT":
            grossEarnings += amt;
            break;
        }
      }

      const netEarnings = grossEarnings - commission + bonuses - penalties + adjustments - cashCollected;

      const { data: invNum } = await supabase.rpc("generate_invoice_number");
      const invoiceNumber = invNum || `INV-${Date.now()}`;

      const { data: template } = await supabase
        .from("invoice_templates")
        .select("id")
        .eq("is_default", true)
        .single();

      const { data: invoice, error: insertError } = await supabase
        .from("invoices")
        .insert({
          invoice_number: invoiceNumber,
          driver_id: params.driverId,
          template_id: template?.id || null,
          period_start: params.periodStart,
          period_end: params.periodEnd,
          region_id: params.regionId,
          service_area_id: params.serviceAreaId && params.serviceAreaId !== "all" ? params.serviceAreaId : null,
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

      if (insertError) throw insertError;

      const items = [
        { invoice_id: invoice.id, item_type: "trip_earnings", description: `Completed trip earnings (${completedTrips.size} trips)`, amount_pence: grossEarnings, sort_order: 1 },
        { invoice_id: invoice.id, item_type: "commission", description: "Platform commission", amount_pence: -commission, sort_order: 2 },
      ];
      if (bonuses > 0) items.push({ invoice_id: invoice.id, item_type: "bonus", description: "Bonuses & incentives", amount_pence: bonuses, sort_order: 3 });
      if (penalties > 0) items.push({ invoice_id: invoice.id, item_type: "penalty", description: "Penalties & deductions", amount_pence: -penalties, sort_order: 4 });
      if (adjustments !== 0) items.push({ invoice_id: invoice.id, item_type: "adjustment", description: "Manual adjustments", amount_pence: adjustments, sort_order: 5 });
      if (cashCollected > 0) items.push({ invoice_id: invoice.id, item_type: "cash_collected", description: "Cash collected (offset)", amount_pence: -cashCollected, sort_order: 6 });
      if (noShowTrips > 0) items.push({ invoice_id: invoice.id, item_type: "no_show", description: `No-show charges (${noShowTrips})`, amount_pence: 0, sort_order: 7 });
      if (lateCancelTrips > 0) items.push({ invoice_id: invoice.id, item_type: "late_cancel", description: `Late cancellation charges (${lateCancelTrips})`, amount_pence: 0, sort_order: 8 });

      await supabase.from("invoice_items").insert(items);
      return invoice;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["invoices"] });
      setGenerateOpen(false);
      setSelectedDriverId(null);
      setGenDriverSearch("");
      toast({ title: "Invoice generated", description: "Draft invoice created successfully" });
    },
    onError: (err: any) => {
      toast({ title: "Error generating invoice", description: err.message, variant: "destructive" });
    },
  });

  // Search drivers for generation
  const { data: driverResults = [] } = useQuery({
    queryKey: ["invoice-driver-search", genDriverSearch],
    queryFn: async () => {
      if (genDriverSearch.length < 2) return [];
      const { data } = await supabase
        .from("drivers")
        .select("id, first_name, last_name, driver_code, region_id")
        .or(`first_name.ilike.%${genDriverSearch}%,last_name.ilike.%${genDriverSearch}%,driver_code.ilike.%${genDriverSearch}%`)
        .limit(10);
      return data || [];
    },
    enabled: genDriverSearch.length >= 2 && !selectedDriverId,
  });

  const openPreview = async (inv: Invoice) => {
    setPreviewInvoice(inv);
    const { data } = await supabase
      .from("invoice_items")
      .select("*")
      .eq("invoice_id", inv.id)
      .order("sort_order");
    setPreviewItems(data || []);
  };

  const sendMutation = useMutation({
    mutationFn: async (invoiceId: string) => {
      const { error } = await supabase
        .from("invoices")
        .update({ status: "sent", sent_at: new Date().toISOString(), finalized_at: new Date().toISOString() })
        .eq("id", invoiceId);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["invoices"] });
      toast({ title: "Invoice sent" });
    },
  });

  const fmtMoney = (pence: number, currency: string) => formatCurrency(pence / 100, currency);

  const filteredServiceAreasForGen = genRegion
    ? serviceAreas.filter((sa: any) => sa.region_id === genRegion)
    : [];

  const filteredServiceAreasForFilter = regionFilter !== "all"
    ? serviceAreas.filter((sa: any) => sa.region_id === regionFilter)
    : serviceAreas;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Invoices</h1>
          <p className="text-muted-foreground">Driver earnings statements — generated per region</p>
        </div>
        <Button onClick={() => setGenerateOpen(true)}>
          <Plus className="h-4 w-4 mr-2" /> Generate Invoice
        </Button>
      </div>

      {/* Filters */}
      <div className="flex gap-3 items-center flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder="Search by invoice #, driver name or code…"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </div>
        <Select value={regionFilter} onValueChange={(v) => { setRegionFilter(v); setServiceAreaFilter("all"); }}>
          <SelectTrigger className="w-44">
            <Globe className="h-3.5 w-3.5 mr-1.5 text-muted-foreground" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Regions</SelectItem>
            {regions.map((r) => (
              <SelectItem key={r.id} value={r.id}>{r.name} ({r.currency_code})</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {filteredServiceAreasForFilter.length > 0 && (
          <Select value={serviceAreaFilter} onValueChange={setServiceAreaFilter}>
            <SelectTrigger className="w-44">
              <MapPin className="h-3.5 w-3.5 mr-1.5 text-muted-foreground" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Service Areas</SelectItem>
              {filteredServiceAreasForFilter.map((sa: any) => (
                <SelectItem key={sa.id} value={sa.id}>{sa.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Statuses</SelectItem>
            <SelectItem value="draft">Draft</SelectItem>
            <SelectItem value="finalized">Finalized</SelectItem>
            <SelectItem value="sent">Sent</SelectItem>
            <SelectItem value="viewed">Viewed</SelectItem>
            <SelectItem value="cancelled">Cancelled</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Summary Cards — grouped by currency */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {Object.entries(currencyGroupedTotals).map(([currency, totals]) => (
          <Card key={currency}>
            <CardContent className="pt-4 pb-3">
              <p className="text-xs text-muted-foreground">{currency} — {totals.count} invoices</p>
              <p className="text-2xl font-bold">{fmtMoney(totals.totalNet, currency)}</p>
              <p className="text-xs text-muted-foreground mt-1">
                {totals.drafts} drafts · {totals.sent} sent
              </p>
            </CardContent>
          </Card>
        ))}
        {Object.keys(currencyGroupedTotals).length === 0 && (
          <Card>
            <CardContent className="pt-4 pb-3">
              <p className="text-xs text-muted-foreground">Total Invoices</p>
              <p className="text-2xl font-bold">0</p>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Invoice Table */}
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Invoice #</TableHead>
                <TableHead>Driver</TableHead>
                <TableHead>Region</TableHead>
                <TableHead>Period</TableHead>
                <TableHead>Trips</TableHead>
                <TableHead className="text-right">Net Earnings</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow><TableCell colSpan={8} className="text-center py-8 text-muted-foreground">Loading…</TableCell></TableRow>
              ) : filteredInvoices.length === 0 ? (
                <TableRow><TableCell colSpan={8} className="text-center py-8 text-muted-foreground">No invoices found</TableCell></TableRow>
              ) : (
                filteredInvoices.map((inv) => {
                  const sc = STATUS_CONFIG[inv.status] || STATUS_CONFIG.draft;
                  return (
                    <TableRow key={inv.id}>
                      <TableCell className="font-mono text-sm">{inv.invoice_number}</TableCell>
                      <TableCell>
                        <div>
                          <span className="font-medium">{inv.drivers?.first_name} {inv.drivers?.last_name}</span>
                          <span className="text-xs text-muted-foreground ml-2">{inv.drivers?.driver_code}</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="text-sm">
                          <span className="font-medium">{inv.regions?.name}</span>
                          {inv.service_areas?.name && (
                            <span className="block text-xs text-muted-foreground">{inv.service_areas.name}</span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-sm">
                        {format(new Date(inv.period_start), "dd MMM")} – {format(new Date(inv.period_end), "dd MMM yyyy")}
                      </TableCell>
                      <TableCell>{inv.completed_trips + inv.no_show_trips + inv.late_cancel_trips}</TableCell>
                      <TableCell className="text-right font-medium">
                        {fmtMoney(inv.net_earnings_pence, inv.currency_code)}
                      </TableCell>
                      <TableCell>
                        <Badge variant={sc.variant}>{sc.label}</Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex gap-1 justify-end">
                          <Button variant="ghost" size="sm" onClick={() => openPreview(inv)}>
                            <Eye className="h-3.5 w-3.5" />
                          </Button>
                          {inv.status === "draft" && (
                            <Button variant="ghost" size="sm" onClick={() => sendMutation.mutate(inv.id)}>
                              <Send className="h-3.5 w-3.5" />
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Generate Invoice Dialog */}
      <Dialog open={generateOpen} onOpenChange={(open) => {
        setGenerateOpen(open);
        if (!open) { setSelectedDriverId(null); setGenDriverSearch(""); }
      }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Generate Driver Earnings Statement</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Search Driver</Label>
              <Input
                value={genDriverSearch}
                onChange={(e) => { setGenDriverSearch(e.target.value); setSelectedDriverId(null); }}
                placeholder="Search by name or driver code…"
              />
              {driverResults.length > 0 && !selectedDriverId && (
                <div className="border rounded-md mt-1 max-h-40 overflow-y-auto">
                  {driverResults.map((d: any) => (
                    <button
                      key={d.id}
                      className="w-full text-left px-3 py-2 hover:bg-muted text-sm flex justify-between"
                      onClick={() => {
                        setGenDriverSearch(`${d.first_name} ${d.last_name} (${d.driver_code})`);
                        setSelectedDriverId(d.id);
                        if (d.region_id) setGenRegion(d.region_id);
                      }}
                    >
                      <span>{d.first_name} {d.last_name}</span>
                      <span className="text-muted-foreground">{d.driver_code}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Period Start</Label>
                <Input type="date" value={genPeriodStart} onChange={(e) => setGenPeriodStart(e.target.value)} />
              </div>
              <div>
                <Label>Period End</Label>
                <Input type="date" value={genPeriodEnd} onChange={(e) => setGenPeriodEnd(e.target.value)} />
              </div>
            </div>
            <div>
              <Label>Region (determines currency)</Label>
              <Select value={genRegion} onValueChange={(v) => { setGenRegion(v); setGenServiceArea(""); }}>
                <SelectTrigger><SelectValue placeholder="Select region" /></SelectTrigger>
                <SelectContent>
                  {regions.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.name} ({r.currency_code})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {genRegion && (
                <p className="text-xs text-muted-foreground mt-1">
                  Currency: <strong>{regions.find(r => r.id === genRegion)?.currency_code}</strong> — All amounts will use this currency
                </p>
              )}
            </div>
            {filteredServiceAreasForGen.length > 0 && (
              <div>
                <Label>Service Area (optional)</Label>
                <Select value={genServiceArea} onValueChange={setGenServiceArea}>
                  <SelectTrigger><SelectValue placeholder="All service areas in region" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Service Areas</SelectItem>
                    {filteredServiceAreasForGen.map((sa: any) => (
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
                  <li>Currency is always determined by the Region</li>
                  <li>Only ledger entries matching the region currency are included</li>
                  <li>One invoice never contains mixed currencies</li>
                  <li>If a driver operates in multiple regions, generate separate invoices per region</li>
                </ul>
              </CardContent>
            </Card>

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setGenerateOpen(false)}>Cancel</Button>
              <Button
                onClick={() => {
                  if (!selectedDriverId || !genPeriodStart || !genPeriodEnd || !genRegion) {
                    toast({ title: "Please fill all fields", variant: "destructive" });
                    return;
                  }
                  generateMutation.mutate({
                    driverId: selectedDriverId,
                    periodStart: genPeriodStart,
                    periodEnd: genPeriodEnd,
                    regionId: genRegion,
                    serviceAreaId: genServiceArea,
                  });
                }}
                disabled={generateMutation.isPending}
              >
                {generateMutation.isPending ? "Generating…" : "Generate Statement"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Preview Dialog */}
      <Dialog open={!!previewInvoice} onOpenChange={() => setPreviewInvoice(null)}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          {previewInvoice && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-3">
                  <FileText className="h-5 w-5" />
                  {previewInvoice.invoice_number}
                  <Badge variant={STATUS_CONFIG[previewInvoice.status]?.variant || "secondary"}>
                    {STATUS_CONFIG[previewInvoice.status]?.label}
                  </Badge>
                </DialogTitle>
              </DialogHeader>
              <div className="space-y-4">
                <div className="grid grid-cols-3 gap-4 text-sm">
                  <div>
                    <p className="text-muted-foreground">Driver</p>
                    <p className="font-medium">{previewInvoice.drivers?.first_name} {previewInvoice.drivers?.last_name}</p>
                    <p className="text-xs text-muted-foreground">{previewInvoice.drivers?.driver_code}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Region</p>
                    <p className="font-medium">{previewInvoice.regions?.name}</p>
                    <p className="text-xs text-muted-foreground">Currency: {previewInvoice.currency_code}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Period</p>
                    <p className="font-medium">
                      {format(new Date(previewInvoice.period_start), "dd MMM yyyy")} – {format(new Date(previewInvoice.period_end), "dd MMM yyyy")}
                    </p>
                  </div>
                </div>

                <Separator />

                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Description</TableHead>
                      <TableHead className="text-right">Amount ({getCurrencySymbol(previewInvoice.currency_code)})</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {previewItems.map((item: any) => (
                      <TableRow key={item.id}>
                        <TableCell>{item.description}</TableCell>
                        <TableCell className={`text-right font-mono ${item.amount_pence < 0 ? "text-destructive" : ""}`}>
                          {item.amount_pence < 0 ? "−" : ""}{fmtMoney(Math.abs(item.amount_pence), previewInvoice.currency_code)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>

                <Separator />

                <div className="flex justify-between items-center text-lg font-bold">
                  <span>Net Earnings</span>
                  <span>{fmtMoney(previewInvoice.net_earnings_pence, previewInvoice.currency_code)}</span>
                </div>

                <div className="grid grid-cols-3 gap-3 text-center text-sm">
                  <div className="border rounded p-2">
                    <p className="text-muted-foreground">Completed</p>
                    <p className="font-bold text-lg">{previewInvoice.completed_trips}</p>
                  </div>
                  <div className="border rounded p-2">
                    <p className="text-muted-foreground">No-Show</p>
                    <p className="font-bold text-lg">{previewInvoice.no_show_trips}</p>
                  </div>
                  <div className="border rounded p-2">
                    <p className="text-muted-foreground">Late Cancel</p>
                    <p className="font-bold text-lg">{previewInvoice.late_cancel_trips}</p>
                  </div>
                </div>

                <div className="flex justify-end gap-2">
                  {previewInvoice.status === "draft" && (
                    <Button onClick={() => { sendMutation.mutate(previewInvoice.id); setPreviewInvoice(null); }}>
                      <Send className="h-4 w-4 mr-2" /> Send Statement
                    </Button>
                  )}
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
