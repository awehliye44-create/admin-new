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
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { toast } from "@/hooks/use-toast";
import { Plus, Pencil, Star, FileText, Building2 } from "lucide-react";

interface InvoiceTemplate {
  id: string;
  name: string;
  is_default: boolean;
  logo_url: string | null;
  company_name: string;
  company_address: string | null;
  company_email: string | null;
  company_phone: string | null;
  company_registration: string | null;
  invoice_title: string;
  payment_terms: string | null;
  due_date_label: string | null;
  notes_footer: string | null;
  table_columns: string[];
  created_at: string;
  updated_at: string;
}

const EMPTY_TEMPLATE: Partial<InvoiceTemplate> = {
  name: "",
  is_default: false,
  logo_url: "",
  company_name: "ONECAB",
  company_address: "",
  company_email: "",
  company_phone: "",
  company_registration: "",
  invoice_title: "Driver Earnings Statement",
  payment_terms: "Payment processed automatically via platform wallet",
  due_date_label: "Statement Period",
  notes_footer: "",
};

export default function InvoiceTemplates() {
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
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
      if (editing) {
        const { error } = await supabase
          .from("invoice_templates")
          .update({ ...values, updated_at: new Date().toISOString() })
          .eq("id", editing.id);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from("invoice_templates")
          .insert(values as any);
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
      // Clear existing defaults
      await supabase.from("invoice_templates").update({ is_default: false }).neq("id", templateId);
      const { error } = await supabase
        .from("invoice_templates")
        .update({ is_default: true })
        .eq("id", templateId);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["invoice-templates"] });
      toast({ title: "Default template updated" });
    },
  });

  const openEdit = (t: InvoiceTemplate) => {
    setEditing(t);
    setForm({
      name: t.name,
      is_default: t.is_default,
      logo_url: t.logo_url || "",
      company_name: t.company_name,
      company_address: t.company_address || "",
      company_email: t.company_email || "",
      company_phone: t.company_phone || "",
      company_registration: t.company_registration || "",
      invoice_title: t.invoice_title,
      payment_terms: t.payment_terms || "",
      due_date_label: t.due_date_label || "",
      notes_footer: t.notes_footer || "",
    });
    setDialogOpen(true);
  };

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY_TEMPLATE);
    setDialogOpen(true);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Invoice Templates</h1>
          <p className="text-muted-foreground">Manage earnings statement templates for driver invoices</p>
        </div>
        <Button onClick={openCreate}>
          <Plus className="h-4 w-4 mr-2" /> New Template
        </Button>
      </div>

      {isLoading ? (
        <div className="text-muted-foreground">Loading templates…</div>
      ) : templates.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <FileText className="h-12 w-12 mx-auto mb-4 opacity-40" />
            <p>No templates yet. Create your first invoice template.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {templates.map((t) => (
            <Card key={t.id} className="relative">
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between">
                  <div>
                    <CardTitle className="text-base flex items-center gap-2">
                      {t.name}
                      {t.is_default && (
                        <Badge variant="secondary" className="text-xs">
                          <Star className="h-3 w-3 mr-1" /> Default
                        </Badge>
                      )}
                    </CardTitle>
                    <CardDescription className="mt-1">{t.invoice_title}</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Building2 className="h-4 w-4" />
                  <span>{t.company_name}</span>
                </div>
                {t.payment_terms && (
                  <p className="text-xs text-muted-foreground line-clamp-2">{t.payment_terms}</p>
                )}
                <div className="flex gap-2 pt-2">
                  <Button variant="outline" size="sm" onClick={() => openEdit(t)}>
                    <Pencil className="h-3 w-3 mr-1" /> Edit
                  </Button>
                  {!t.is_default && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setDefaultMutation.mutate(t.id)}
                    >
                      <Star className="h-3 w-3 mr-1" /> Set Default
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Template Editor Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit Template" : "New Template"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Template Name</Label>
                <Input
                  value={form.name || ""}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="e.g. Monthly Statement"
                />
              </div>
              <div>
                <Label>Invoice Title</Label>
                <Input
                  value={form.invoice_title || ""}
                  onChange={(e) => setForm({ ...form, invoice_title: e.target.value })}
                  placeholder="Driver Earnings Statement"
                />
              </div>
            </div>

            <div className="border rounded-lg p-4 space-y-3">
              <h3 className="font-medium text-sm">Company Details</h3>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Company Name</Label>
                  <Input
                    value={form.company_name || ""}
                    onChange={(e) => setForm({ ...form, company_name: e.target.value })}
                  />
                </div>
                <div>
                  <Label>Registration No.</Label>
                  <Input
                    value={form.company_registration || ""}
                    onChange={(e) => setForm({ ...form, company_registration: e.target.value })}
                  />
                </div>
                <div>
                  <Label>Email</Label>
                  <Input
                    value={form.company_email || ""}
                    onChange={(e) => setForm({ ...form, company_email: e.target.value })}
                  />
                </div>
                <div>
                  <Label>Phone</Label>
                  <Input
                    value={form.company_phone || ""}
                    onChange={(e) => setForm({ ...form, company_phone: e.target.value })}
                  />
                </div>
              </div>
              <div>
                <Label>Address</Label>
                <Textarea
                  value={form.company_address || ""}
                  onChange={(e) => setForm({ ...form, company_address: e.target.value })}
                  rows={2}
                />
              </div>
              <div>
                <Label>Logo URL</Label>
                <Input
                  value={form.logo_url || ""}
                  onChange={(e) => setForm({ ...form, logo_url: e.target.value })}
                  placeholder="https://example.com/logo.png"
                />
              </div>
            </div>

            <div className="border rounded-lg p-4 space-y-3">
              <h3 className="font-medium text-sm">Statement Details</h3>
              <div>
                <Label>Period Label</Label>
                <Input
                  value={form.due_date_label || ""}
                  onChange={(e) => setForm({ ...form, due_date_label: e.target.value })}
                  placeholder="Statement Period"
                />
              </div>
              <div>
                <Label>Payment Terms</Label>
                <Textarea
                  value={form.payment_terms || ""}
                  onChange={(e) => setForm({ ...form, payment_terms: e.target.value })}
                  rows={2}
                />
              </div>
              <div>
                <Label>Notes / Footer</Label>
                <Textarea
                  value={form.notes_footer || ""}
                  onChange={(e) => setForm({ ...form, notes_footer: e.target.value })}
                  rows={3}
                  placeholder="Additional notes appearing at the bottom of the statement"
                />
              </div>
            </div>

            <div className="flex items-center justify-between pt-2">
              <div className="flex items-center gap-2">
                <Switch
                  checked={form.is_default || false}
                  onCheckedChange={(v) => setForm({ ...form, is_default: v })}
                />
                <Label>Set as default template</Label>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setDialogOpen(false)}>
                  Cancel
                </Button>
                <Button
                  onClick={() => saveMutation.mutate(form)}
                  disabled={saveMutation.isPending || !form.name}
                >
                  {saveMutation.isPending ? "Saving…" : editing ? "Update" : "Create"}
                </Button>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
