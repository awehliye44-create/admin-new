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
  CheckCircle, Clock, Mail, XCircle, Plus, Globe, MapPin, Calculator,
} from "lucide-react";
import { Link } from "react-router-dom";
import { FinanceSsotOperationalNotice } from "@/components/finance/FinanceSSOTBadge";

const STATUS_CONFIG: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  draft: { label: "Pending", variant: "secondary" },
  finalized: { label: "Pending", variant: "secondary" },
  sent: { label: "Sent", variant: "default" },
  viewed: { label: "Paid", variant: "default" },
  paid: { label: "Paid", variant: "default" },
  cancelled: { label: "Cancelled", variant: "destructive" },
};

async function readFunctionError(error: unknown): Promise<string> {
  const asAny = error as { message?: string; context?: unknown };
  if (asAny?.context instanceof Response) {
    try {
      const payload = await asAny.context.clone().json() as { error?: string; message?: string };
      if (payload?.error) return payload.error;
      if (payload?.message) return payload.message;
    } catch {
      /* ignore parse failures */
    }
  }
  return asAny?.message || "Edge function call failed";
}

function invoiceDriverName(inv: Invoice): string {
  const joined = inv.drivers
    ? `${inv.drivers.first_name ?? ""} ${inv.drivers.last_name ?? ""}`.trim()
    : "";
  if (joined) return joined;
  if (inv.driver_display_name?.trim()) return inv.driver_display_name.trim();
  if (inv.driver_id) return `Driver ${inv.driver_id.slice(0, 8)}…`;
  return "Unknown driver";
}

function invoiceDriverCode(inv: Invoice): string | null {
  return inv.drivers?.driver_code ?? inv.driver_display_code ?? null;
}

async function invokeDriverInvoice(body: Record<string, unknown>) {
  const { data, error } = await supabase.functions.invoke("admin-driver-invoice", { body });
  if (error) {
    throw new Error(await readFunctionError(error));
  }
  if (!data) {
    throw new Error("Empty response from invoice service");
  }
  if (data.success === false || data.ok === false) {
    throw new Error(data.error || data.message || "Invoice action failed");
  }
  return data;
}

interface Invoice {
  id: string;
  invoice_number: string;
  driver_id: string | null;
  period_start: string;
  period_end: string;
  currency_code: string;
  gross_earnings_pence: number;
  commission_pence: number;
  bonuses_pence: number;
  penalties_pence: number;
  adjustments_pence: number;
  net_earnings_pence: number;
  completed_trips: number;
  no_show_trips: number;
  late_cancel_trips: number;
  status: string;
  pdf_storage_path: string | null;
  invoice_pdf_url: string | null;
  invoice_generated_at: string | null;
  invoice_email_sent: boolean | null;
  invoice_email_sent_at: string | null;
  invoice_email_status: string | null;
  invoice_email_error: string | null;
  card_trips: number | null;
  created_at: string;
  sent_at: string | null;
  viewed_at: string | null;
  region_id: string;
  service_area_id: string | null;
  statement_run_id: string | null;
  drivers?: { first_name: string; last_name: string; driver_code: string } | null;
  driver_display_name?: string | null;
  driver_display_code?: string | null;
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
  const [monthFilter, setMonthFilter] = useState("all");
  const [driverFilter, setDriverFilter] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [actionLoading, setActionLoading] = useState<string | null>(null);
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
    let list = invoices;
    if (monthFilter !== "all") {
      list = list.filter((inv) => inv.period_start?.startsWith(monthFilter));
    }
    if (driverFilter.trim()) {
      const term = driverFilter.toLowerCase();
      list = list.filter((inv) => {
        const name = invoiceDriverName(inv).toLowerCase();
        const code = invoiceDriverCode(inv)?.toLowerCase() ?? "";
        return name.includes(term) || code.includes(term);
      });
    }
    if (!searchTerm) return list;
    const term = searchTerm.toLowerCase();
    return list.filter(
      (inv) =>
        inv.invoice_number.toLowerCase().includes(term) ||
        invoiceDriverName(inv).toLowerCase().includes(term) ||
        (invoiceDriverCode(inv)?.toLowerCase().includes(term) ?? false)
    );
  }, [invoices, searchTerm, monthFilter, driverFilter]);

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

  const generateMutation = useMutation({
    mutationFn: async (params: { driverId: string; periodStart: string; periodEnd: string; regionId: string; serviceAreaId?: string }) => {
      return invokeDriverInvoice({
        action: "generate",
        driver_id: params.driverId,
        period_start: params.periodStart,
        period_end: params.periodEnd,
        region_id: params.regionId,
        service_area_id: params.serviceAreaId && params.serviceAreaId !== "all" ? params.serviceAreaId : null,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["invoices"] });
      setGenerateOpen(false);
      setSelectedDriverId(null);
      setGenDriverSearch("");
      toast({ title: "Invoice generated", description: "PDF created and ready to send" });
    },
    onError: (err: any) => {
      toast({ title: "Error generating invoice", description: err.message, variant: "destructive" });
    },
  });

  const runInvoiceAction = async (
    inv: Invoice,
    action: "send_email" | "resend_email" | "regenerate" | "download" | "view",
  ) => {
    setActionLoading(`${action}-${inv.id}`);
    try {
      const data = await invokeDriverInvoice({
        action,
        invoice_id: inv.id,
      });

      if (action === "download" || action === "view") {
        const url = data.pdfUrl ?? data.pdf_url ?? inv.invoice_pdf_url;
        if (!url) throw new Error(data.error || "Invoice file not available");
        window.open(url, "_blank", "noopener,noreferrer");
        toast({
          title: action === "download" ? "Invoice downloaded successfully" : "Invoice opened",
        });
      } else if (action === "regenerate") {
        toast({ title: "Invoice PDF generated successfully" });
      } else if (action === "send_email" || action === "resend_email") {
        toast({ title: "Invoice email sent successfully" });
      }

      queryClient.invalidateQueries({ queryKey: ["invoices"] });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error";
      const title = action === "send_email" || action === "resend_email"
        ? "Invoice email failed"
        : "Invoice action failed";
      toast({
        title,
        description: message,
        variant: "destructive",
      });
    } finally {
      setActionLoading(null);
    }
  };

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

  const monthOptions = useMemo(() => {
    const months = new Set<string>();
    for (const inv of invoices) {
      if (inv.period_start) months.add(inv.period_start.slice(0, 7));
    }
    return Array.from(months).sort().reverse();
  }, [invoices]);

  const fmtMoney = (pence: number, currency: string) => formatCurrency(pence / 100, currency);

  const filteredServiceAreasForGen = genRegion
    ? serviceAreas.filter((sa: any) => sa.region_id === genRegion)
    : [];

  const filteredServiceAreasForFilter = regionFilter !== "all"
    ? serviceAreas.filter((sa: any) => sa.region_id === regionFilter)
    : serviceAreas;

  return (
    <div className="space-y-6">
      <FinanceSsotOperationalNotice />
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
        <Select value={monthFilter} onValueChange={setMonthFilter}>
          <SelectTrigger className="w-40">
            <SelectValue placeholder="All months" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Months</SelectItem>
            {monthOptions.map((m) => (
              <SelectItem key={m} value={m}>{format(new Date(`${m}-01`), "MMMM yyyy")}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          className="w-44"
          placeholder="Filter by driver…"
          value={driverFilter}
          onChange={(e) => setDriverFilter(e.target.value)}
        />
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Statuses</SelectItem>
            <SelectItem value="draft">Pending</SelectItem>
            <SelectItem value="finalized">Pending</SelectItem>
            <SelectItem value="sent">Sent</SelectItem>
            <SelectItem value="viewed">Paid</SelectItem>
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
                <TableHead>Invoice Month</TableHead>
                <TableHead>Trips</TableHead>
                <TableHead className="text-right">Net Earnings</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Generated</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow><TableCell colSpan={9} className="text-center py-8 text-muted-foreground">Loading…</TableCell></TableRow>
              ) : filteredInvoices.length === 0 ? (
                <TableRow><TableCell colSpan={9} className="text-center py-8 text-muted-foreground">No invoices found</TableCell></TableRow>
              ) : (
                filteredInvoices.map((inv) => {
                  const sc = STATUS_CONFIG[inv.status] || STATUS_CONFIG.draft;
                  return (
                    <TableRow key={inv.id}>
                      <TableCell className="font-mono text-sm">{inv.invoice_number}</TableCell>
                      <TableCell>
                        <div>
                          <span className="font-medium">{invoiceDriverName(inv)}</span>
                          {invoiceDriverCode(inv) && (
                            <span className="text-xs text-muted-foreground ml-2">{invoiceDriverCode(inv)}</span>
                          )}
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
                        {format(new Date(inv.period_start), "MMMM yyyy")}
                      </TableCell>
                      <TableCell>{inv.completed_trips + inv.no_show_trips + inv.late_cancel_trips}</TableCell>
                      <TableCell className="text-right font-medium">
                        {fmtMoney(inv.net_earnings_pence, inv.currency_code)}
                      </TableCell>
                      <TableCell>
                        <Badge variant={sc.variant}>{sc.label}</Badge>
                        {inv.invoice_email_status === "failed" && (
                          <p className="text-[10px] text-destructive mt-0.5">Email failed</p>
                        )}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {inv.invoice_generated_at
                          ? format(new Date(inv.invoice_generated_at), "dd MMM yyyy HH:mm")
                          : "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex gap-1 justify-end flex-wrap">
                          <Button variant="ghost" size="sm" title="View" onClick={() => runInvoiceAction(inv, "view")} disabled={!!actionLoading}>
                            <Eye className="h-3.5 w-3.5" />
                          </Button>
                          <Button variant="ghost" size="sm" title="Download PDF" onClick={() => runInvoiceAction(inv, "download")} disabled={!!actionLoading}>
                            <Download className="h-3.5 w-3.5" />
                          </Button>
                          <Button variant="ghost" size="sm" title="Details" onClick={() => openPreview(inv)}>
                            <FileText className="h-3.5 w-3.5" />
                          </Button>
                          {!inv.invoice_email_sent && (
                            <Button variant="ghost" size="sm" title="Send Email" onClick={() => runInvoiceAction(inv, "send_email")} disabled={!!actionLoading}>
                              <Mail className="h-3.5 w-3.5" />
                            </Button>
                          )}
                          {inv.invoice_email_sent && (
                            <Button variant="ghost" size="sm" title="Resend Email" onClick={() => runInvoiceAction(inv, "resend_email")} disabled={!!actionLoading}>
                              <RefreshCw className="h-3.5 w-3.5" />
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
                    <p className="font-medium">{invoiceDriverName(previewInvoice)}</p>
                    {invoiceDriverCode(previewInvoice) && (
                      <p className="text-xs text-muted-foreground">{invoiceDriverCode(previewInvoice)}</p>
                    )}
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

                <div className="rounded-md border border-primary/30 bg-primary/5 p-3 text-sm text-muted-foreground space-y-2">
                  <p className="flex items-center gap-2 font-medium text-foreground">
                    <Calculator className="h-4 w-4" />
                    Trip-level commission &amp; settlement (SSOT)
                  </p>
                  <p>
                    Line items below are period statement totals from Financial Reconciliation audit data.
                    Per-trip gross fare, commission, and driver net:{' '}
                    <Link to="/trip-history" className="underline">Trip History (Trip Settlement SSOT)</Link>
                    {' · '}
                    <Link to={`/driver-wallet-ledger?driverId=${previewInvoice.driver_id ?? ''}`} className="underline">Driver Wallet Ledger</Link>
                  </p>
                </div>

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

                <div className="flex justify-end gap-2 flex-wrap">
                  <Button variant="outline" onClick={() => runInvoiceAction(previewInvoice, "view")}>
                    <Eye className="h-4 w-4 mr-2" /> View Invoice
                  </Button>
                  <Button variant="outline" onClick={() => runInvoiceAction(previewInvoice, "download")}>
                    <Download className="h-4 w-4 mr-2" /> Download PDF
                  </Button>
                  <Button variant="secondary" onClick={() => runInvoiceAction(previewInvoice, "regenerate")}>
                    <RefreshCw className="h-4 w-4 mr-2" /> Regenerate
                  </Button>
                  {!previewInvoice.invoice_email_sent ? (
                    <Button onClick={() => { runInvoiceAction(previewInvoice, "send_email"); setPreviewInvoice(null); }}>
                      <Send className="h-4 w-4 mr-2" /> Send Email
                    </Button>
                  ) : (
                    <Button onClick={() => { runInvoiceAction(previewInvoice, "resend_email"); setPreviewInvoice(null); }}>
                      <Mail className="h-4 w-4 mr-2" /> Resend Email
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
