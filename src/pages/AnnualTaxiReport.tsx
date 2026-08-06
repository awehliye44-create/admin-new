import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { Link } from "react-router-dom";
import { Download, FileText, Loader2, Mail, RefreshCw } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { AdminLayout } from "@/components/layout/AdminLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useToast } from "@/hooks/use-toast";
import { Info } from "lucide-react";

type PeriodMode = "tax_year" | "calendar_year";

interface DriverRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
  driver_code: string | null;
  region_id: string | null;
}

interface RegionRow {
  id: string;
  name: string;
  currency_code: string | null;
}

function ukTaxYearRange(startYear: number) {
  return { start: `${startYear}-04-06`, end: `${startYear + 1}-04-05` };
}

function calendarYearRange(year: number) {
  return { start: `${year}-01-01`, end: `${year}-12-31` };
}

function driverName(d: DriverRow | undefined): string {
  if (!d) return "Unknown";
  return [d.first_name, d.last_name].filter(Boolean).join(" ") || d.driver_code || d.id;
}

async function readFunctionError(error: unknown): Promise<string> {
  const asAny = error as { message?: string; context?: unknown };
  if (asAny?.context instanceof Response) {
    try {
      const payload = (await asAny.context.clone().json()) as { error?: string; message?: string };
      if (payload?.error) return payload.error;
      if (payload?.message) return payload.message;
    } catch {
      /* ignore */
    }
  }
  return asAny?.message || "Edge function call failed";
}

async function invokeDriverInvoice(body: Record<string, unknown>) {
  const { data, error } = await supabase.functions.invoke("admin-driver-invoice", { body });
  if (error) throw new Error(await readFunctionError(error));
  if (!data) throw new Error("Empty response from invoice service");
  if (data.success === false || data.ok === false) {
    throw new Error(data.error || data.message || "Invoice action failed");
  }
  return data;
}

/**
 * Annual driver statement — same branded invoice as monthly.
 * Only the selected period differs; PDF/HTML design is identical.
 */
export default function AnnualTaxiReport() {
  const { toast } = useToast();
  const currentYear = new Date().getFullYear();

  const [regionId, setRegionId] = useState<string>("");
  const [driverId, setDriverId] = useState<string>("");
  const [periodMode, setPeriodMode] = useState<PeriodMode>("tax_year");
  const [taxYearStart, setTaxYearStart] = useState(String(currentYear - 1));
  const [calendarYear, setCalendarYear] = useState(String(currentYear - 1));

  const [invoiceId, setInvoiceId] = useState<string | null>(null);
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);

  const { data: regions = [] } = useQuery({
    queryKey: ["atr-regions"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("regions")
        .select("id,name,currency_code")
        .order("name");
      if (error) throw error;
      return (data ?? []) as RegionRow[];
    },
  });

  const { data: drivers = [] } = useQuery({
    queryKey: ["atr-drivers", regionId],
    queryFn: async () => {
      let q = supabase
        .from("drivers")
        .select("id,first_name,last_name,driver_code,region_id")
        .order("driver_code", { ascending: true })
        .limit(1000);
      if (regionId) q = q.eq("region_id", regionId);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as DriverRow[];
    },
  });

  const driver = useMemo(
    () => drivers.find((d) => d.id === driverId),
    [drivers, driverId],
  );

  useEffect(() => {
    if (driver?.region_id && !regionId) {
      setRegionId(driver.region_id);
    }
  }, [driver?.region_id, regionId]);

  const dateRange = useMemo(() => {
    if (periodMode === "tax_year") return ukTaxYearRange(Number(taxYearStart));
    return calendarYearRange(Number(calendarYear));
  }, [periodMode, taxYearStart, calendarYear]);

  const periodLabel = useMemo(() => {
    if (periodMode === "tax_year") {
      return `UK tax year ${taxYearStart}/${String(Number(taxYearStart) + 1).slice(2)} (${format(new Date(dateRange.start), "dd MMM yyyy")} – ${format(new Date(dateRange.end), "dd MMM yyyy")})`;
    }
    return `Calendar year ${calendarYear} (${format(new Date(dateRange.start), "dd MMM yyyy")} – ${format(new Date(dateRange.end), "dd MMM yyyy")})`;
  }, [periodMode, taxYearStart, calendarYear, dateRange]);

  const resolvedRegionId = regionId || driver?.region_id || "";
  const canGenerate = !!driverId && !!resolvedRegionId && !!dateRange.start && !!dateRange.end;

  const loadPreview = async (id: string) => {
    const data = await invokeDriverInvoice({ action: "preview", invoice_id: id });
    const html = data.html as string | undefined;
    if (!html) throw new Error("Invoice preview HTML missing");
    setPreviewHtml(html);
    setInvoiceId(id);
  };

  const generateMutation = useMutation({
    mutationFn: async () => {
      if (!driverId || !resolvedRegionId) throw new Error("Select driver and region");

      // Reuse existing statement for this exact period when present.
      const { data: existing } = await supabase
        .from("invoices")
        .select("id")
        .eq("driver_id", driverId)
        .eq("region_id", resolvedRegionId)
        .eq("period_start", dateRange.start)
        .eq("period_end", dateRange.end)
        .not("status", "eq", "cancelled")
        .maybeSingle();

      let id = existing?.id as string | undefined;
      if (!id) {
        const created = await invokeDriverInvoice({
          action: "generate",
          driver_id: driverId,
          period_start: dateRange.start,
          period_end: dateRange.end,
          region_id: resolvedRegionId,
        });
        id = (created.invoice_id || created.invoiceId) as string | undefined;
        if (!id) throw new Error("Generate succeeded but no invoice_id returned");
      } else {
        // Refresh PDF/HTML so latest design (no commission) applies.
        await invokeDriverInvoice({ action: "regenerate", invoice_id: id });
      }

      await loadPreview(id);
      return id;
    },
    onSuccess: () => {
      toast({
        title: "Annual statement ready",
        description: "Same invoice design as monthly — period covers the selected year.",
      });
    },
    onError: (err: Error) => {
      toast({ title: "Could not generate statement", description: err.message, variant: "destructive" });
    },
  });

  const actionMutation = useMutation({
    mutationFn: async (action: "download" | "view" | "send_email" | "regenerate") => {
      if (!invoiceId) throw new Error("No invoice loaded");
      const data = await invokeDriverInvoice({ action, invoice_id: invoiceId });
      if (action === "download" || action === "view") {
        const url = data.pdfUrl ?? data.pdf_url;
        if (!url) throw new Error("PDF URL missing");
        window.open(url, "_blank", "noopener,noreferrer");
      }
      if (action === "regenerate") {
        await loadPreview(invoiceId);
      }
      return action;
    },
    onSuccess: (action) => {
      if (action === "send_email") toast({ title: "Invoice email sent" });
      if (action === "regenerate") toast({ title: "Statement regenerated" });
      if (action === "download" || action === "view") toast({ title: "PDF opened" });
    },
    onError: (err: Error) => {
      toast({ title: "Action failed", description: err.message, variant: "destructive" });
    },
  });

  return (
    <AdminLayout
      title="Annual Driver Statement"
      description="Same driver earnings invoice as monthly — only the period is annual."
    >
      <div className="space-y-6">
        <Alert>
          <Info className="h-4 w-4" />
          <AlertTitle>Same design as monthly invoices</AlertTitle>
          <AlertDescription>
            This generates the normal Driver Earnings Statement PDF/HTML for a full year (UK tax year or
            calendar year). Layout matches{" "}
            <Link to="/invoices" className="underline">
              Driver Invoices
            </Link>
            . Platform commission is not shown on the statement.
          </AlertDescription>
        </Alert>

        <Card className="print:hidden">
          <CardHeader>
            <CardTitle>Generate annual statement</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label>Region</Label>
                <Select
                  value={regionId || "__all__"}
                  onValueChange={(v) => {
                    setRegionId(v === "__all__" ? "" : v);
                    setDriverId("");
                    setPreviewHtml(null);
                    setInvoiceId(null);
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select region" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__all__">All regions</SelectItem>
                    {regions.map((r) => (
                      <SelectItem key={r.id} value={r.id}>
                        {r.name}
                        {r.currency_code ? ` (${r.currency_code})` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2 md:col-span-2">
                <Label>Driver</Label>
                <Select
                  value={driverId}
                  onValueChange={(v) => {
                    setDriverId(v);
                    setPreviewHtml(null);
                    setInvoiceId(null);
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select a driver…" />
                  </SelectTrigger>
                  <SelectContent className="max-h-72">
                    {drivers.map((d) => (
                      <SelectItem key={d.id} value={d.id}>
                        {d.driver_code ? `${d.driver_code} — ` : ""}
                        {driverName(d)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-3">
              <Label>Period</Label>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant={periodMode === "tax_year" ? "default" : "outline"}
                  onClick={() => setPeriodMode("tax_year")}
                >
                  UK tax year
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={periodMode === "calendar_year" ? "default" : "outline"}
                  onClick={() => setPeriodMode("calendar_year")}
                >
                  Calendar year
                </Button>
              </div>
              {periodMode === "tax_year" ? (
                <div className="space-y-2 max-w-xs">
                  <Label>Tax year start</Label>
                  <Select value={taxYearStart} onValueChange={setTaxYearStart}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Array.from({ length: 8 }).map((_, i) => {
                        const y = currentYear - i;
                        return (
                          <SelectItem key={y} value={String(y)}>
                            {y}/{(y + 1).toString().slice(2)}
                          </SelectItem>
                        );
                      })}
                    </SelectContent>
                  </Select>
                </div>
              ) : (
                <div className="space-y-2 max-w-xs">
                  <Label>Year</Label>
                  <Select value={calendarYear} onValueChange={setCalendarYear}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Array.from({ length: 8 }).map((_, i) => {
                        const y = currentYear - i;
                        return (
                          <SelectItem key={y} value={String(y)}>
                            {y}
                          </SelectItem>
                        );
                      })}
                    </SelectContent>
                  </Select>
                </div>
              )}
              <p className="text-sm text-muted-foreground">{periodLabel}</p>
            </div>

            <div className="flex flex-wrap gap-2 pt-2">
              <Button
                onClick={() => generateMutation.mutate()}
                disabled={!canGenerate || generateMutation.isPending}
              >
                {generateMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <FileText className="h-4 w-4" />
                )}
                Generate statement
              </Button>
              {invoiceId && (
                <>
                  <Button
                    variant="outline"
                    disabled={actionMutation.isPending}
                    onClick={() => actionMutation.mutate("view")}
                  >
                    <Download className="h-4 w-4" />
                    View / download PDF
                  </Button>
                  <Button
                    variant="outline"
                    disabled={actionMutation.isPending}
                    onClick={() => actionMutation.mutate("regenerate")}
                  >
                    <RefreshCw className="h-4 w-4" />
                    Regenerate
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={actionMutation.isPending}
                    onClick={() => actionMutation.mutate("send_email")}
                  >
                    <Mail className="h-4 w-4" />
                    Email to driver
                  </Button>
                </>
              )}
            </div>
          </CardContent>
        </Card>

        {generateMutation.isPending && (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Building statement (same layout as monthly)…
          </div>
        )}

        {previewHtml && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">
                Statement preview · {driverName(driver)} · {periodLabel}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="rounded-md border border-border overflow-hidden bg-white">
                <iframe
                  title="Driver earnings statement"
                  srcDoc={previewHtml}
                  className="w-full min-h-[1100px] bg-white"
                />
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </AdminLayout>
  );
}
