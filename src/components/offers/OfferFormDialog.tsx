import { useState, useEffect } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useServiceAreas } from "@/hooks/useServiceAreas";
import { CustomerOfferCard } from "@/components/offers/CustomerOfferCard";
import type { OfferWithAreas } from "@/hooks/useOffers";
import { toast } from "sonner";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  offer?: OfferWithAreas | null;
}

const EMPTY = {
  name: "",
  code: "",
  description: "",
  offer_type: "percent_discount" as "percent_discount" | "fixed_amount_discount",
  discount_value: 10,
  currency: "GBP",
  min_fare_pence: 0,
  max_discount_pence: null as number | null,
  starts_at: new Date().toISOString().slice(0, 16),
  ends_at: "" as string,
  is_enabled: true,
  status: "active" as "draft" | "active" | "archived",
  first_ride_only: false,
  new_customer_only: false,
  per_user_limit: null as number | null,
  total_usage_limit: null as number | null,
  priority: 100,
  terms: "",
  banner_title: "",
  banner_subtitle: "",
  cta_text: "View offer",
  badge_text: "",
  style_variant: "default",
  service_area_ids: [] as string[],
};

export function OfferFormDialog({ open, onOpenChange, offer }: Props) {
  const qc = useQueryClient();
  const { data: areas = [] } = useServiceAreas();
  const [form, setForm] = useState(EMPTY);
  const [allAreas, setAllAreas] = useState(true);

  useEffect(() => {
    if (!open) return;
    if (offer) {
      setForm({
        name: offer.name,
        code: offer.code,
        description: offer.description ?? "",
        offer_type: offer.offer_type,
        discount_value: Number(offer.discount_value),
        currency: offer.currency,
        min_fare_pence: offer.min_fare_pence,
        max_discount_pence: offer.max_discount_pence,
        starts_at: offer.starts_at.slice(0, 16),
        ends_at: offer.ends_at ? offer.ends_at.slice(0, 16) : "",
        is_enabled: offer.is_enabled,
        status: offer.status,
        first_ride_only: offer.first_ride_only,
        new_customer_only: offer.new_customer_only,
        per_user_limit: offer.per_user_limit,
        total_usage_limit: offer.total_usage_limit,
        priority: offer.priority,
        terms: offer.terms ?? "",
        banner_title: offer.banner_title,
        banner_subtitle: offer.banner_subtitle ?? "",
        cta_text: offer.cta_text,
        badge_text: offer.badge_text ?? "",
        style_variant: offer.style_variant,
        service_area_ids: offer.service_area_ids,
      });
      setAllAreas(offer.service_area_ids.length === 0);
    } else {
      setForm(EMPTY);
      setAllAreas(true);
    }
  }, [open, offer]);

  const save = useMutation({
    mutationFn: async () => {
      if (!form.name.trim() || !form.code.trim() || !form.banner_title.trim()) {
        throw new Error("Name, code, and banner title are required");
      }
      const payload = {
        name: form.name.trim(),
        code: form.code.trim().toUpperCase(),
        description: form.description.trim() || null,
        offer_type: form.offer_type,
        discount_value: form.discount_value,
        currency: form.currency,
        min_fare_pence: form.min_fare_pence,
        max_discount_pence: form.max_discount_pence,
        starts_at: new Date(form.starts_at).toISOString(),
        ends_at: form.ends_at ? new Date(form.ends_at).toISOString() : null,
        is_enabled: form.is_enabled,
        status: form.status,
        first_ride_only: form.first_ride_only,
        new_customer_only: form.new_customer_only,
        per_user_limit: form.per_user_limit,
        total_usage_limit: form.total_usage_limit,
        priority: form.priority,
        terms: form.terms.trim() || null,
        banner_title: form.banner_title.trim(),
        banner_subtitle: form.banner_subtitle.trim() || null,
        cta_text: form.cta_text.trim() || "View offer",
        badge_text: form.badge_text.trim() || null,
        style_variant: form.style_variant,
      };

      let offerId = offer?.id;
      if (offerId) {
        const { error } = await supabase.from("offers" as any).update(payload).eq("id", offerId);
        if (error) throw error;
      } else {
        const { data, error } = await supabase.from("offers" as any).insert(payload).select("id").single();
        if (error) throw error;
        offerId = (data as any).id;
      }

      // Reset service area links
      await supabase.from("offer_service_areas" as any).delete().eq("offer_id", offerId!);
      if (!allAreas && form.service_area_ids.length > 0) {
        const rows = form.service_area_ids.map((sa) => ({ offer_id: offerId, service_area_id: sa }));
        const { error } = await supabase.from("offer_service_areas" as any).insert(rows);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-offers"] });
      toast.success(offer ? "Offer updated" : "Offer created");
      onOpenChange(false);
    },
    onError: (e: any) => toast.error(e.message ?? "Failed to save offer"),
  });

  const previewOffer = {
    id: "preview",
    name: form.name,
    code: form.code,
    description: form.description || null,
    offer_type: form.offer_type,
    discount_value: form.discount_value,
    currency: form.currency,
    min_fare_pence: form.min_fare_pence,
    max_discount_pence: form.max_discount_pence,
    starts_at: new Date().toISOString(),
    ends_at: null,
    is_enabled: true,
    status: "active" as const,
    first_ride_only: false,
    new_customer_only: false,
    per_user_limit: null,
    total_usage_limit: null,
    usage_count: 0,
    priority: 100,
    terms: null,
    banner_title: form.banner_title || "Your offer title",
    banner_subtitle: form.banner_subtitle || "A short description shown under the title",
    cta_text: form.cta_text || "View offer",
    badge_text: form.badge_text || null,
    style_variant: form.style_variant,
    created_at: "",
    updated_at: "",
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{offer ? "Edit offer" : "Create offer"}</DialogTitle>
          <DialogDescription>
            Build a customer-facing offer. Fully admin-controlled, per-service-area, original ONECAB design.
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="basics" className="mt-2">
          <TabsList>
            <TabsTrigger value="basics">Basics</TabsTrigger>
            <TabsTrigger value="discount">Discount</TabsTrigger>
            <TabsTrigger value="rules">Eligibility</TabsTrigger>
            <TabsTrigger value="display">Display</TabsTrigger>
            <TabsTrigger value="areas">Service areas</TabsTrigger>
            <TabsTrigger value="preview">Preview</TabsTrigger>
          </TabsList>

          <TabsContent value="basics" className="space-y-3 pt-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Internal name</Label>
                <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </div>
              <div>
                <Label>Internal code (unique)</Label>
                <Input
                  value={form.code}
                  onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
                  placeholder="WELCOME40"
                />
              </div>
            </div>
            <div>
              <Label>Description (internal)</Label>
              <Textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={2} />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <Label>Status</Label>
                <Select value={form.status} onValueChange={(v: any) => setForm({ ...form, status: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="draft">Draft</SelectItem>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="archived">Archived</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-end gap-2">
                <Switch checked={form.is_enabled} onCheckedChange={(v) => setForm({ ...form, is_enabled: v })} />
                <Label>Enabled</Label>
              </div>
              <div>
                <Label>Priority (higher first)</Label>
                <Input type="number" value={form.priority} onChange={(e) => setForm({ ...form, priority: parseInt(e.target.value) || 0 })} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Starts at</Label>
                <Input type="datetime-local" value={form.starts_at} onChange={(e) => setForm({ ...form, starts_at: e.target.value })} />
              </div>
              <div>
                <Label>Ends at (optional)</Label>
                <Input type="datetime-local" value={form.ends_at} onChange={(e) => setForm({ ...form, ends_at: e.target.value })} />
              </div>
            </div>
          </TabsContent>

          <TabsContent value="discount" className="space-y-3 pt-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Type</Label>
                <Select
                  value={form.offer_type}
                  onValueChange={(v: any) =>
                    setForm({ ...form, offer_type: v, discount_value: v === "percent_discount" ? 10 : 2 })
                  }
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="percent_discount">Percentage discount (e.g. 40%)</SelectItem>
                    <SelectItem value="fixed_amount_discount">Fixed amount (e.g. £2)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {form.offer_type === "percent_discount" ? (
                <div>
                  <Label htmlFor="discount-percent">Percent (1–100)</Label>
                  <div className="relative">
                    <Input
                      id="discount-percent"
                      type="number"
                      inputMode="decimal"
                      min={1}
                      max={100}
                      step="1"
                      placeholder="Enter %"
                      value={form.discount_value === 0 ? "" : String(form.discount_value)}
                      onChange={(e) => {
                        const raw = e.target.value;
                        if (raw === "") {
                          setForm({ ...form, discount_value: 0 });
                          return;
                        }
                        const n = parseFloat(raw);
                        if (Number.isNaN(n)) return;
                        setForm({ ...form, discount_value: Math.min(100, Math.max(0, n)) });
                      }}
                      className="pr-8"
                    />
                    <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                      %
                    </span>
                  </div>
                  {form.discount_value > 0 && (form.discount_value < 1 || form.discount_value > 100) && (
                    <p className="mt-1 text-xs text-destructive">Percent must be between 1 and 100.</p>
                  )}
                </div>
              ) : (
                <div>
                  <Label htmlFor="discount-amount">Amount ({form.currency || "GBP"})</Label>
                  <div className="relative">
                    <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                      {form.currency === "GBP" ? "£" : form.currency === "USD" ? "$" : form.currency === "EUR" ? "€" : form.currency}
                    </span>
                    <Input
                      id="discount-amount"
                      type="number"
                      inputMode="decimal"
                      min={0}
                      step="0.01"
                      placeholder="Enter amount"
                      value={form.discount_value === 0 ? "" : String(form.discount_value)}
                      onChange={(e) => {
                        const raw = e.target.value;
                        if (raw === "") {
                          setForm({ ...form, discount_value: 0 });
                          return;
                        }
                        const n = parseFloat(raw);
                        if (Number.isNaN(n)) return;
                        setForm({ ...form, discount_value: Math.max(0, n) });
                      }}
                      className="pl-8"
                    />
                  </div>
                  {form.discount_value !== 0 && form.discount_value <= 0 && (
                    <p className="mt-1 text-xs text-destructive">Amount must be greater than 0.</p>
                  )}
                </div>
              )}
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div>
                <Label>Currency</Label>
                <Input
                  value={form.currency}
                  onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase() })}
                  maxLength={3}
                />
              </div>
              <div>
                <Label>Min fare (pence)</Label>
                <Input
                  type="number"
                  min={0}
                  value={form.min_fare_pence}
                  onChange={(e) =>
                    setForm({ ...form, min_fare_pence: e.target.value === "" ? 0 : parseInt(e.target.value) || 0 })
                  }
                />
              </div>
              <div>
                <Label>Max discount cap (pence, optional)</Label>
                <Input
                  type="number"
                  min={0}
                  placeholder="No cap"
                  value={form.max_discount_pence ?? ""}
                  onChange={(e) =>
                    setForm({ ...form, max_discount_pence: e.target.value ? parseInt(e.target.value) : null })
                  }
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Discount applies only to ride fare. Waiting fees, cancellation fees, no-show fees, tolls and tips are excluded.
            </p>
          </TabsContent>

          <TabsContent value="rules" className="space-y-3 pt-3">
            <div className="flex items-center gap-2">
              <Switch checked={form.first_ride_only} onCheckedChange={(v) => setForm({ ...form, first_ride_only: v })} />
              <Label>First ride only</Label>
            </div>
            <div className="flex items-center gap-2">
              <Switch checked={form.new_customer_only} onCheckedChange={(v) => setForm({ ...form, new_customer_only: v })} />
              <Label>New customer only</Label>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Per-user limit (optional)</Label>
                <Input
                  type="number"
                  value={form.per_user_limit ?? ""}
                  onChange={(e) => setForm({ ...form, per_user_limit: e.target.value ? parseInt(e.target.value) : null })}
                />
              </div>
              <div>
                <Label>Total usage limit (optional)</Label>
                <Input
                  type="number"
                  value={form.total_usage_limit ?? ""}
                  onChange={(e) => setForm({ ...form, total_usage_limit: e.target.value ? parseInt(e.target.value) : null })}
                />
              </div>
            </div>
            <div>
              <Label>Terms (shown to customer)</Label>
              <Textarea value={form.terms} onChange={(e) => setForm({ ...form, terms: e.target.value })} rows={3} />
            </div>
          </TabsContent>

          <TabsContent value="display" className="space-y-3 pt-3">
            <div>
              <Label>Banner title</Label>
              <Input value={form.banner_title} onChange={(e) => setForm({ ...form, banner_title: e.target.value })} />
            </div>
            <div>
              <Label>Banner subtitle</Label>
              <Input value={form.banner_subtitle} onChange={(e) => setForm({ ...form, banner_subtitle: e.target.value })} />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <Label>CTA text</Label>
                <Input value={form.cta_text} onChange={(e) => setForm({ ...form, cta_text: e.target.value })} />
              </div>
              <div>
                <Label>Badge text (optional)</Label>
                <Input value={form.badge_text} onChange={(e) => setForm({ ...form, badge_text: e.target.value })} />
              </div>
              <div>
                <Label>Style variant</Label>
                <Select value={form.style_variant} onValueChange={(v) => setForm({ ...form, style_variant: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="default">Default</SelectItem>
                    <SelectItem value="bold">Bold</SelectItem>
                    <SelectItem value="subtle">Subtle</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="areas" className="space-y-3 pt-3">
            <div className="flex items-center gap-2">
              <Switch checked={allAreas} onCheckedChange={setAllAreas} />
              <Label>Apply to all service areas</Label>
            </div>
            {!allAreas && (
              <div className="grid grid-cols-2 gap-2 rounded-md border p-3 max-h-72 overflow-y-auto">
                {areas.map((a) => {
                  const checked = form.service_area_ids.includes(a.id);
                  return (
                    <label key={a.id} className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(v) => {
                          setForm((f) => ({
                            ...f,
                            service_area_ids: v
                              ? [...f.service_area_ids, a.id]
                              : f.service_area_ids.filter((x) => x !== a.id),
                          }));
                        }}
                      />
                      <span>{a.name}</span>
                    </label>
                  );
                })}
              </div>
            )}
          </TabsContent>

          <TabsContent value="preview" className="pt-3">
            <p className="mb-3 text-sm text-muted-foreground">Customer home preview:</p>
            <div className="max-w-md">
              <CustomerOfferCard offer={previewOffer as any} onView={() => {}} onDismiss={() => {}} />
            </div>
          </TabsContent>
        </Tabs>

        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? "Saving…" : offer ? "Update offer" : "Create offer"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
