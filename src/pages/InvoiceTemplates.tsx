import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/hooks/use-toast";
import { Plus, Pencil, Star, FileText, Building2, Eye, RefreshCw } from "lucide-react";

interface InvoiceTemplate {
  id: string;
  name: string;
  is_default: boolean;
  template_type: string | null;
  logo_url: string | null;
  company_name: string;
  company_address: string | null;
  company_email: string | null;
  company_phone: string | null;
  company_website: string | null;
  company_registration: string | null;
  invoice_title: string;
  payment_terms: string | null;
  due_date_label: string | null;
  notes_footer: string | null;
  footer_text: string | null;
  email_subject: string | null;
  email_body: string | null;
  auto_email_enabled: boolean | null;
  table_columns: string[];
  created_at: string;
  updated_at: string;
}

const DEFAULT_EMAIL_BODY = `Dear {{driverName}},

Thank you for driving with ONECAB.

Your monthly earnings statement for {{invoicePeriod}} has been generated and is attached as a PDF.

Invoice Number: {{invoiceNo}}
Total Trips: {{totalTrips}}
Net Driver Earnings: {{netDriverEarnings}}

Please review the attached statement for your records.

If you have any questions regarding your earnings, please contact the ONECAB support team.

Kind regards,
ONECAB Team
One App. Every Journey.

{{companyName}}
{{companyAddress}}
Phone: {{companyPhone}}
Email: {{companyEmail}}
Website: {{companyWebsite}}`;

const EMPTY_TEMPLATE: Partial<InvoiceTemplate> = {
  name: "Driver Monthly Invoice",
  template_type: "driver_monthly",
  is_default: true,
  logo_url: "",
  company_name: "ONECAB",
  company_address: "",
  company_email: "",
  company_phone: "",
  company_website: "",
  company_registration: "",
  invoice_title: "Driver Earnings Statement",
  payment_terms: "Payment processed automatically via platform wallet",
  due_date_label: "Statement Period",
  notes_footer: "",
  footer_text: "If you have any questions regarding your earnings, please contact our support team.",
  email_subject: "Your ONECAB Monthly Earnings Statement - {{invoiceNo}}",
  email_body: DEFAULT_EMAIL_BODY,
  auto_email_enabled: false,
};

async function loadCompanyFromSettings() {
  const { data } = await supabase
    .from("admin_settings")
    .select("setting_key, setting_value")
    .in("setting_key", ["company_info", "branding_settings"]);
  const map = new Map((data ?? []).map((r) => [r.setting_key, r.setting_value]));
  const company = (map.get("company_info") ?? {}) as Record<string, string>;
  const branding = (map.get("branding_settings") ?? {}) as Record<string, string>;
  const address = [company.address, company.city, company.state, company.zipCode, company.country]
    .filter(Boolean)
    .join(", ");
  return {
    company_name: company.name || company.legalName || "ONECAB",
    company_address: address,
    company_email: company.email || "",
    company_phone: company.phone || "",
    company_website: company.website || "",
    logo_url: branding.logoUrl || "",
  };
}

export default function InvoiceTemplates() {
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewHtml, setPreviewHtml] = useState("");
  const [editing, setEditing] = useState<InvoiceTemplate | null>(null);
  const [form, setForm] = useState<Partial<InvoiceTemplate>>(EMPTY_TEMPLATE);

  const { data: templates = [], isLoading } = useQuery({
    queryKey: ["invoice-templates"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("invoice_templates")
        .select("*")
        .order("is_default", { ascending: false });
      if (error) throw error;
      return data as InvoiceTemplate[];
    },
  });

  const saveMutation = useMutation({
    mutationFn: async (values: Partial<InvoiceTemplate>) => {
      const payload = { ...values, template_type: "driver_monthly", updated_at: new Date().toISOString() };
      if (editing) {
        const { error } = await supabase.from("invoice_templates").update(payload).eq("id", editing.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("invoice_templates").insert(payload as any);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["invoice-templates"] });
      setDialogOpen(false);
      setEditing(null);
      setForm(EMPTY_TEMPLATE);
      toast({ title: editing ? "Template updated" : "Template created" });
    },
    onError: (err: any) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const setDefaultMutation = useMutation({
    mutationFn: async (templateId: string) => {
      await supabase.from("invoice_templates").update({ is_default: false }).neq("id", templateId);
      const { error } = await supabase.from("invoice_templates").update({ is_default: true }).eq("id", templateId);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["invoice-templates"] });
      toast({ title: "Default template updated" });
    },
  });

  const syncCompanyMutation = useMutation({
    mutationFn: loadCompanyFromSettings,
    onSuccess: (company) => {
      setForm((prev) => ({ ...prev, ...company }));
      toast({ title: "Company details loaded from General & Branding" });
    },
  });

  const previewMutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke("admin-driver-invoice", {
        body: {
          action: "preview",
          sample: true,
          invoice_title: form.invoice_title,
          footer_text: form.footer_text || form.notes_footer,
        },
      });
      if (error) throw error;
      return data?.html as string;
    },
    onSuccess: (html) => {
      setPreviewHtml(html || "<p>Preview unavailable</p>");
      setPreviewOpen(true);
    },
    onError: (err: any) => {
      toast({ title: "Preview failed", description: err.message, variant: "destructive" });
    },
  });

  const openEdit = (t: InvoiceTemplate) => {
    setEditing(t);
    setForm({
      name: t.name,
      is_default: t.is_default,
      template_type: t.template_type || "driver_monthly",
      logo_url: t.logo_url || "",
      company_name: t.company_name,
      company_address: t.company_address || "",
      company_email: t.company_email || "",
      company_phone: t.company_phone || "",
      company_website: t.company_website || "",
      company_registration: t.company_registration || "",
      invoice_title: t.invoice_title,
      payment_terms: t.payment_terms || "",
      due_date_label: t.due_date_label || "",
      notes_footer: t.notes_footer || "",
      footer_text: t.footer_text || t.notes_footer || "",
      email_subject: t.email_subject || EMPTY_TEMPLATE.email_subject!,
      email_body: t.email_body || DEFAULT_EMAIL_BODY,
      auto_email_enabled: t.auto_email_enabled ?? false,
    });
    setDialogOpen(true);
  };

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY_TEMPLATE);
    setDialogOpen(true);
  };

  const driverTemplate = templates.find((t) => t.template_type === "driver_monthly" || t.is_default) ?? templates[0];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Invoice Templates</h1>
          <p className="text-muted-foreground">Manage the Driver Monthly Invoice template, email, and PDF preview</p>
        </div>
        <Button onClick={openCreate}>
          <Plus className="h-4 w-4 mr-2" /> New Template
        </Button>
      </div>

      {driverTemplate && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <FileText className="h-4 w-4" />
              Driver Monthly Invoice Template
              {driverTemplate.is_default && <Badge variant="secondary">Default</Badge>}
            </CardTitle>
            <CardDescription>Company details are refreshed from General &amp; Branding when invoices are generated and emailed.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => openEdit(driverTemplate)}>
              <Pencil className="h-3 w-3 mr-1" /> Edit Template
            </Button>
            <Button variant="outline" size="sm" onClick={() => previewMutation.mutate()} disabled={previewMutation.isPending}>
              <Eye className="h-3 w-3 mr-1" /> PDF Preview
            </Button>
          </CardContent>
        </Card>
      )}

      {isLoading ? (
        <div className="text-muted-foreground">Loading templates…</div>
      ) : templates.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <FileText className="h-12 w-12 mx-auto mb-4 opacity-40" />
            <p>No templates yet. Create your first driver monthly invoice template.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {templates.map((t) => (
            <Card key={t.id} className="relative">
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  {t.name}
                  {t.is_default && (
                    <Badge variant="secondary" className="text-xs">
                      <Star className="h-3 w-3 mr-1" /> Default
                    </Badge>
                  )}
                </CardTitle>
                <CardDescription>{t.invoice_title}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Building2 className="h-4 w-4" />
                  <span>{t.company_name}</span>
                </div>
                {t.auto_email_enabled && (
                  <Badge variant="outline" className="text-xs">Auto Email On</Badge>
                )}
                <div className="flex gap-2 pt-2 flex-wrap">
                  <Button variant="outline" size="sm" onClick={() => openEdit(t)}>
                    <Pencil className="h-3 w-3 mr-1" /> Edit
                  </Button>
                  {!t.is_default && (
                    <Button variant="ghost" size="sm" onClick={() => setDefaultMutation.mutate(t.id)}>
                      <Star className="h-3 w-3 mr-1" /> Set Default
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit Driver Monthly Template" : "New Driver Monthly Template"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Template Name</Label>
                <Input value={form.name || ""} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </div>
              <div>
                <Label>Invoice Title</Label>
                <Input value={form.invoice_title || ""} onChange={(e) => setForm({ ...form, invoice_title: e.target.value })} />
              </div>
            </div>

            <div className="border rounded-lg p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="font-medium text-sm">Company Information</h3>
                <Button type="button" variant="outline" size="sm" onClick={() => syncCompanyMutation.mutate()} disabled={syncCompanyMutation.isPending}>
                  <RefreshCw className="h-3 w-3 mr-1" /> Sync from General &amp; Branding
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">Invoices always use the latest General &amp; Branding company details at generation/email time. These fields are fallbacks for the template editor.</p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Company Name</Label>
                  <Input value={form.company_name || ""} onChange={(e) => setForm({ ...form, company_name: e.target.value })} />
                </div>
                <div>
                  <Label>Website</Label>
                  <Input value={form.company_website || ""} onChange={(e) => setForm({ ...form, company_website: e.target.value })} />
                </div>
                <div>
                  <Label>Email</Label>
                  <Input value={form.company_email || ""} onChange={(e) => setForm({ ...form, company_email: e.target.value })} />
                </div>
                <div>
                  <Label>Phone</Label>
                  <Input value={form.company_phone || ""} onChange={(e) => setForm({ ...form, company_phone: e.target.value })} />
                </div>
              </div>
              <div>
                <Label>Address</Label>
                <Textarea value={form.company_address || ""} onChange={(e) => setForm({ ...form, company_address: e.target.value })} rows={2} />
              </div>
              <div>
                <Label>ONECAB Logo URL</Label>
                <Input value={form.logo_url || ""} onChange={(e) => setForm({ ...form, logo_url: e.target.value })} placeholder="Uses branding logo from General Settings when empty" />
              </div>
            </div>

            <div className="border rounded-lg p-4 space-y-3">
              <h3 className="font-medium text-sm">Email Settings</h3>
              <div>
                <Label>Email Subject</Label>
                <Input value={form.email_subject || ""} onChange={(e) => setForm({ ...form, email_subject: e.target.value })} />
              </div>
              <div>
                <Label>Email Body</Label>
                <Textarea value={form.email_body || ""} onChange={(e) => setForm({ ...form, email_body: e.target.value })} rows={12} className="font-mono text-xs" />
              </div>
              <div className="flex items-center gap-2">
                <Switch checked={form.auto_email_enabled || false} onCheckedChange={(v) => setForm({ ...form, auto_email_enabled: v })} />
                <Label>Automatically email invoice to driver when generated</Label>
              </div>
            </div>

            <div className="border rounded-lg p-4 space-y-3">
              <h3 className="font-medium text-sm">Footer Text</h3>
              <Textarea value={form.footer_text || ""} onChange={(e) => setForm({ ...form, footer_text: e.target.value, notes_footer: e.target.value })} rows={3} />
            </div>

            <div className="flex items-center justify-between pt-2">
              <div className="flex items-center gap-2">
                <Switch checked={form.is_default || false} onCheckedChange={(v) => setForm({ ...form, is_default: v })} />
                <Label>Set as default template</Label>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => previewMutation.mutate()} disabled={previewMutation.isPending}>
                  <Eye className="h-4 w-4 mr-2" /> Preview
                </Button>
                <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
                <Button onClick={() => saveMutation.mutate(form)} disabled={saveMutation.isPending || !form.name}>
                  {saveMutation.isPending ? "Saving…" : editing ? "Update" : "Create"}
                </Button>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto p-0">
          <DialogHeader className="p-6 pb-0">
            <DialogTitle>PDF Preview — Driver Monthly Invoice</DialogTitle>
          </DialogHeader>
          <iframe title="Invoice preview" className="w-full h-[80vh] border-0" srcDoc={previewHtml} />
        </DialogContent>
      </Dialog>
    </div>
  );
}
