import { useCallback, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import {
  BarChart3,
  Calendar,
  Clock,
  Loader2,
  PartyPopper,
  RefreshCw,
  Send,
  Sparkles,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useRegions } from "@/hooks/useRegions";
import { useServiceAreas } from "@/hooks/useServiceAreas";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "sonner";
import {
  CAMPAIGN_HEADS_UP_CATEGORIES,
  type CampaignAccentColor,
  type CampaignHeadsUpCategory,
  type CampaignScheduleMode,
  type CampaignTargetApp,
} from "../../../shared/campaignHeadsUpTemplates";

interface CampaignTemplate {
  id: string;
  slug: string;
  category: CampaignHeadsUpCategory;
  name: string;
  title: string;
  subtitle: string;
  emoji: string | null;
  accent_color: string;
  gradient_from: string;
  gradient_to: string;
  background_image_url: string | null;
  cta_label: string | null;
  cta_url: string | null;
  deep_link: string | null;
  default_target_app: CampaignTargetApp;
}

interface CampaignRow {
  id: string;
  template_slug: string | null;
  category: string;
  title: string;
  subtitle: string;
  emoji: string | null;
  accent_color: string;
  gradient_from: string;
  gradient_to: string;
  background_image_url: string | null;
  cta_label: string | null;
  cta_url: string | null;
  deep_link: string | null;
  target_scope: string;
  target_app: CampaignTargetApp;
  target_region_id: string | null;
  target_service_area_id: string | null;
  priority: string;
  schedule_mode: CampaignScheduleMode;
  scheduled_at: string | null;
  starts_at: string | null;
  ends_at: string | null;
  status: string;
  sent_count: number;
  delivered_count: number;
  opened_count: number;
  dismissed_count: number;
  tapped_count: number;
  failed_count: number;
  sent_at: string | null;
  created_at: string;
}

const ACCENT_SWATCHES: CampaignAccentColor[] = [
  "blue", "pink", "purple", "green", "yellow", "orange", "red",
];

const ACCENT_HEX: Record<CampaignAccentColor, { from: string; to: string }> = {
  blue: { from: "#1e3a8a", to: "#3b82f6" },
  pink: { from: "#9d174d", to: "#f9a8d4" },
  purple: { from: "#581c87", to: "#d8b4fe" },
  green: { from: "#166534", to: "#86efac" },
  yellow: { from: "#a16207", to: "#fde047" },
  orange: { from: "#c2410c", to: "#fdba74" },
  red: { from: "#991b1b", to: "#f87171" },
};

const emptyForm = {
  templateId: "",
  category: "celebration" as CampaignHeadsUpCategory,
  title: "",
  subtitle: "",
  emoji: "🎉",
  accent_color: "blue" as CampaignAccentColor,
  gradient_from: ACCENT_HEX.blue.from,
  gradient_to: ACCENT_HEX.blue.to,
  background_image_url: "",
  cta_label: "",
  cta_url: "",
  deep_link: "",
  target_scope: "global",
  target_app: "customer" as CampaignTargetApp,
  target_region_id: "",
  target_service_area_id: "",
  target_user_segment: "",
  target_user_ids: "",
  languages: "en",
  priority: "normal",
  schedule_mode: "instant" as CampaignScheduleMode,
  scheduled_at: "",
  starts_at: "",
  ends_at: "",
};

export function CampaignHeadsUpSection() {
  const queryClient = useQueryClient();
  const { data: regions = [] } = useRegions();
  const { data: serviceAreas = [] } = useServiceAreas({ activeOnly: true });
  const [form, setForm] = useState(emptyForm);
  const [isSaving, setIsSaving] = useState(false);

  const { data: templates = [], isLoading: loadingTemplates } = useQuery({
    queryKey: ["campaign-heads-up-templates"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("campaign_heads_up_templates")
        .select("*")
        .eq("is_active", true)
        .order("category")
        .order("name");
      if (error) throw error;
      return (data ?? []) as CampaignTemplate[];
    },
  });

  const { data: campaigns = [], isLoading: loadingCampaigns } = useQuery({
    queryKey: ["campaign-heads-up-campaigns"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("campaign_heads_up_campaigns")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return (data ?? []) as CampaignRow[];
    },
  });

  const filteredTemplates = useMemo(
    () => templates.filter((t) => t.category === form.category),
    [templates, form.category],
  );

  const analytics = useMemo(() => {
    const sent = campaigns.reduce((s, c) => s + (c.sent_count ?? 0), 0);
    const delivered = campaigns.reduce((s, c) => s + (c.delivered_count ?? 0), 0);
    const opened = campaigns.reduce((s, c) => s + (c.opened_count ?? 0), 0);
    const tapped = campaigns.reduce((s, c) => s + (c.tapped_count ?? 0), 0);
    const dismissed = campaigns.reduce((s, c) => s + (c.dismissed_count ?? 0), 0);
    return {
      sent,
      delivered,
      openRate: delivered > 0 ? Math.round((opened / delivered) * 100) : 0,
      tapRate: delivered > 0 ? Math.round((tapped / delivered) * 100) : 0,
      dismissRate: delivered > 0 ? Math.round((dismissed / delivered) * 100) : 0,
    };
  }, [campaigns]);

  const analyticsByApp = useMemo(() => {
    const groups: Record<string, { sent: number; delivered: number; opened: number; tapped: number }> = {};
    for (const c of campaigns) {
      const key = c.target_app ?? "unknown";
      if (!groups[key]) groups[key] = { sent: 0, delivered: 0, opened: 0, tapped: 0 };
      groups[key].sent += c.sent_count ?? 0;
      groups[key].delivered += c.delivered_count ?? 0;
      groups[key].opened += c.opened_count ?? 0;
      groups[key].tapped += c.tapped_count ?? 0;
    }
    return groups;
  }, [campaigns]);

  const analyticsByCategory = useMemo(() => {
    const groups: Record<string, number> = {};
    for (const c of campaigns) {
      groups[c.category] = (groups[c.category] ?? 0) + (c.delivered_count ?? 0);
    }
    return groups;
  }, [campaigns]);

  const applyTemplate = useCallback((template: CampaignTemplate) => {
    setForm((prev) => ({
      ...prev,
      templateId: template.id,
      category: template.category,
      title: template.title,
      subtitle: template.subtitle,
      emoji: template.emoji ?? "🎉",
      accent_color: template.accent_color as CampaignAccentColor,
      gradient_from: template.gradient_from,
      gradient_to: template.gradient_to,
      background_image_url: template.background_image_url ?? "",
      cta_label: template.cta_label ?? "",
      cta_url: template.cta_url ?? "",
      deep_link: template.deep_link ?? template.cta_url ?? "",
      target_app: template.default_target_app,
    }));
  }, []);

  const saveCampaign = async (asDraft: boolean) => {
    if (!form.title.trim() || !form.subtitle.trim()) {
      toast.error("Title and message are required");
      return;
    }
    setIsSaving(true);
    try {
      const selectedTemplate = templates.find((t) => t.id === form.templateId);
      const { data: row, error } = await supabase
        .from("campaign_heads_up_campaigns")
        .insert({
          template_id: form.templateId || null,
          template_slug: selectedTemplate?.slug ?? null,
          category: form.category,
          title: form.title.trim(),
          subtitle: form.subtitle.trim(),
          emoji: form.emoji,
          accent_color: form.accent_color,
          gradient_from: form.gradient_from,
          gradient_to: form.gradient_to,
          background_image_url: form.background_image_url || null,
          cta_label: form.cta_label || null,
          cta_url: form.cta_url || null,
          deep_link: form.deep_link || form.cta_url || null,
          target_scope: form.target_scope,
          target_app: form.target_app,
          target_region_id: form.target_region_id || null,
          target_service_area_id: form.target_service_area_id || null,
          target_user_segment: form.target_user_segment || null,
          target_user_ids: form.target_scope === "users" && form.target_user_ids.trim()
            ? form.target_user_ids.split(/[\s,]+/).filter(Boolean)
            : null,
          languages: form.languages.split(/[\s,]+/).filter(Boolean),
          priority: form.priority,
          schedule_mode: form.schedule_mode,
          scheduled_at: form.scheduled_at || null,
          starts_at: form.starts_at || null,
          ends_at: form.ends_at || null,
          status: asDraft ? "draft" : form.schedule_mode === "scheduled" ? "scheduled" : "draft",
        })
        .select("id")
        .single();
      if (error) throw error;

      if (!asDraft && form.schedule_mode === "instant") {
        const { error: sendErr } = await supabase.functions.invoke("send-campaign-heads-up", {
          body: { campaignId: row.id },
        });
        if (sendErr) throw sendErr;
        toast.success("Campaign sent");
      } else if (asDraft) {
        toast.success("Campaign saved as draft");
      } else {
        toast.success("Campaign scheduled");
      }

      queryClient.invalidateQueries({ queryKey: ["campaign-heads-up-campaigns"] });
      setForm(emptyForm);
    } catch (err) {
      console.error(err);
      toast.error("Failed to save campaign");
    } finally {
      setIsSaving(false);
    }
  };

  const sendExisting = async (campaignId: string) => {
    setIsSaving(true);
    try {
      const { error } = await supabase.functions.invoke("send-campaign-heads-up", {
        body: { campaignId },
      });
      if (error) throw error;
      toast.success("Campaign dispatched");
      queryClient.invalidateQueries({ queryKey: ["campaign-heads-up-campaigns"] });
    } catch (err) {
      console.error(err);
      toast.error("Send failed");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-xl font-semibold flex items-center gap-2">
            <PartyPopper className="h-5 w-5 text-primary" />
            Campaign / Celebration Heads-Up
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            Reusable, editable, targeted, scheduled — completely separate from operational trip heads-up.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => queryClient.invalidateQueries({ queryKey: ["campaign-heads-up-campaigns"] })}>
          <RefreshCw className="mr-2 h-4 w-4" />
          Refresh
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-5">
        <Card><CardHeader className="pb-2"><CardTitle className="text-sm">Sent</CardTitle></CardHeader><CardContent><p className="text-2xl font-bold">{analytics.sent}</p></CardContent></Card>
        <Card><CardHeader className="pb-2"><CardTitle className="text-sm">Delivered</CardTitle></CardHeader><CardContent><p className="text-2xl font-bold">{analytics.delivered}</p></CardContent></Card>
        <Card><CardHeader className="pb-2"><CardTitle className="text-sm">Open Rate</CardTitle></CardHeader><CardContent><p className="text-2xl font-bold">{analytics.openRate}%</p></CardContent></Card>
        <Card><CardHeader className="pb-2"><CardTitle className="text-sm">Tap Rate</CardTitle></CardHeader><CardContent><p className="text-2xl font-bold">{analytics.tapRate}%</p></CardContent></Card>
        <Card><CardHeader className="pb-2"><CardTitle className="text-sm">Dismiss Rate</CardTitle></CardHeader><CardContent><p className="text-2xl font-bold">{analytics.dismissRate}%</p></CardContent></Card>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">By target app</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            {Object.entries(analyticsByApp).map(([app, stats]) => (
              <div key={app} className="flex justify-between">
                <span className="capitalize">{app}</span>
                <span className="text-muted-foreground">{stats.delivered} delivered · {stats.tapped} tapped</span>
              </div>
            ))}
            {Object.keys(analyticsByApp).length === 0 && <p className="text-muted-foreground">No campaigns sent yet</p>}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">By category</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            {Object.entries(analyticsByCategory).map(([cat, delivered]) => (
              <div key={cat} className="flex justify-between capitalize">
                <span>{cat}</span>
                <span className="text-muted-foreground">{delivered} delivered</span>
              </div>
            ))}
            {Object.keys(analyticsByCategory).length === 0 && <p className="text-muted-foreground">No campaigns sent yet</p>}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 xl:grid-cols-[1fr_320px]">
        <Card>
          <CardHeader>
            <CardTitle>Create Campaign / Celebration Notification</CardTitle>
            <CardDescription>Select a reusable template, edit copy, target users, and send or schedule.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label>Category</Label>
                <Select value={form.category} onValueChange={(v) => setForm({ ...form, category: v as CampaignHeadsUpCategory, templateId: "" })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Object.entries(CAMPAIGN_HEADS_UP_CATEGORIES).map(([key, meta]) => (
                      <SelectItem key={key} value={key}>{meta.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Template</Label>
                <Select value={form.templateId} onValueChange={(id) => {
                  const t = templates.find((x) => x.id === id);
                  if (t) applyTemplate(t);
                }}>
                  <SelectTrigger><SelectValue placeholder="Choose template" /></SelectTrigger>
                  <SelectContent>
                    {filteredTemplates.map((t) => (
                      <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <Label>Title</Label>
              <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>Message</Label>
              <Textarea value={form.subtitle} onChange={(e) => setForm({ ...form, subtitle: e.target.value })} rows={3} />
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label>Emoji</Label>
                <Input value={form.emoji} onChange={(e) => setForm({ ...form, emoji: e.target.value })} placeholder="🎉" />
              </div>
              <div className="space-y-2">
                <Label>Background image URL</Label>
                <Input value={form.background_image_url} onChange={(e) => setForm({ ...form, background_image_url: e.target.value })} placeholder="https://..." />
              </div>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label>Action Label</Label>
                <Input value={form.cta_label} onChange={(e) => setForm({ ...form, cta_label: e.target.value })} placeholder="See Details" />
              </div>
              <div className="space-y-2">
                <Label>Action URL / Deep Link</Label>
                <Input value={form.cta_url} onChange={(e) => setForm({ ...form, cta_url: e.target.value, deep_link: e.target.value })} placeholder="/promotions/champions-league" />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Accent / Gradient</Label>
              <div className="flex flex-wrap gap-2">
                {ACCENT_SWATCHES.map((color) => (
                  <button
                    key={color}
                    type="button"
                    className={`h-8 w-8 rounded-full border-2 ${form.accent_color === color ? "border-foreground" : "border-transparent"}`}
                    style={{ background: `linear-gradient(135deg, ${ACCENT_HEX[color].from}, ${ACCENT_HEX[color].to})` }}
                    onClick={() => setForm({
                      ...form,
                      accent_color: color,
                      gradient_from: ACCENT_HEX[color].from,
                      gradient_to: ACCENT_HEX[color].to,
                    })}
                    aria-label={color}
                  />
                ))}
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label>Target App</Label>
                <Select value={form.target_app} onValueChange={(v) => setForm({ ...form, target_app: v as CampaignTargetApp })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="customer">Customer App</SelectItem>
                    <SelectItem value="driver">Driver App</SelectItem>
                    <SelectItem value="both">Both</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Delivery Scope</Label>
                <Select value={form.target_scope} onValueChange={(v) => setForm({ ...form, target_scope: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="global">Global</SelectItem>
                    <SelectItem value="region">Region</SelectItem>
                    <SelectItem value="service_area">Service Area</SelectItem>
                    <SelectItem value="users">Specific Users</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {form.target_scope === "region" && (
              <div className="space-y-2">
                <Label>Region</Label>
                <Select value={form.target_region_id} onValueChange={(v) => setForm({ ...form, target_region_id: v })}>
                  <SelectTrigger><SelectValue placeholder="Select region" /></SelectTrigger>
                  <SelectContent>
                    {regions.map((r) => (
                      <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {form.target_scope === "service_area" && (
              <div className="space-y-2">
                <Label>Service Area</Label>
                <Select value={form.target_service_area_id} onValueChange={(v) => setForm({ ...form, target_service_area_id: v })}>
                  <SelectTrigger><SelectValue placeholder="Select service area" /></SelectTrigger>
                  <SelectContent>
                    {serviceAreas.map((sa) => (
                      <SelectItem key={sa.id} value={sa.id}>{sa.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {form.target_scope === "users" && (
              <div className="space-y-2">
                <Label>User IDs (comma-separated UUIDs)</Label>
                <Textarea value={form.target_user_ids} onChange={(e) => setForm({ ...form, target_user_ids: e.target.value })} rows={2} placeholder="uuid-1, uuid-2" />
              </div>
            )}

            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label>User segment (optional)</Label>
                <Input value={form.target_user_segment} onChange={(e) => setForm({ ...form, target_user_segment: e.target.value })} placeholder="e.g. new_users, vip" />
              </div>
              <div className="space-y-2">
                <Label>Languages</Label>
                <Input value={form.languages} onChange={(e) => setForm({ ...form, languages: e.target.value })} placeholder="en, so, sw" />
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-3">
              <div className="space-y-2">
                <Label>Start date</Label>
                <Input type="datetime-local" value={form.starts_at} onChange={(e) => setForm({ ...form, starts_at: e.target.value })} />
              </div>
              <div className="space-y-2">
                <Label>Priority</Label>
                <Select value={form.priority} onValueChange={(v) => setForm({ ...form, priority: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="low">Low</SelectItem>
                    <SelectItem value="normal">Normal</SelectItem>
                    <SelectItem value="high">High</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Schedule</Label>
                <Select value={form.schedule_mode} onValueChange={(v) => setForm({ ...form, schedule_mode: v as CampaignScheduleMode })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="instant">Send now</SelectItem>
                    <SelectItem value="scheduled">Schedule</SelectItem>
                    <SelectItem value="repeat_yearly">Repeat yearly</SelectItem>
                    <SelectItem value="repeat_monthly">Repeat monthly</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Expiry</Label>
                <Input type="datetime-local" value={form.ends_at} onChange={(e) => setForm({ ...form, ends_at: e.target.value })} />
              </div>
            </div>

            {form.schedule_mode === "scheduled" && (
              <div className="space-y-2">
                <Label>Scheduled at</Label>
                <Input type="datetime-local" value={form.scheduled_at} onChange={(e) => setForm({ ...form, scheduled_at: e.target.value })} />
              </div>
            )}

            <div className="flex flex-wrap gap-2 pt-2">
              <Button disabled={isSaving} onClick={() => saveCampaign(false)}>
                {isSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
                Send Now
              </Button>
              <Button variant="outline" disabled={isSaving} onClick={() => saveCampaign(true)}>
                <Clock className="mr-2 h-4 w-4" />
                Save Draft
              </Button>
              {form.schedule_mode === "scheduled" && (
                <Button variant="secondary" disabled={isSaving} onClick={() => saveCampaign(false)}>
                  <Calendar className="mr-2 h-4 w-4" />
                  Schedule
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        <Card className="overflow-hidden">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Heads-Up Preview</CardTitle>
            <CardDescription>Auto dismisses in 4 seconds. Tap to action.</CardDescription>
          </CardHeader>
          <CardContent>
            <div
              className="rounded-2xl p-4 text-white shadow-lg"
              style={{ background: `linear-gradient(135deg, ${form.gradient_from}, ${form.gradient_to})` }}
            >
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-xl bg-white/20 flex items-center justify-center text-lg shrink-0">🚖</div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-bold text-sm leading-tight">{form.title || "Campaign title"}</p>
                    <span className="text-[10px] text-white/80">now</span>
                  </div>
                  <p className="text-xs text-white/90 mt-1">{form.subtitle || "Campaign message preview"}</p>
                  {form.cta_label ? (
                    <span className="inline-block mt-2 text-xs font-semibold bg-white/20 rounded-full px-3 py-1">
                      {form.cta_label}
                    </span>
                  ) : null}
                </div>
                {form.emoji ? <span className="text-2xl">{form.emoji}</span> : null}
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <div>
        <h3 className="text-base font-semibold mb-3 flex items-center gap-2">
          <Sparkles className="h-4 w-4" />
          Pre-built Mojo Templates
        </h3>
        {loadingTemplates ? (
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
            {templates.map((t) => (
              <button
                key={t.id}
                type="button"
                className="text-left rounded-xl border p-3 hover:border-primary transition-colors"
                style={{ background: `linear-gradient(135deg, ${t.gradient_from}22, ${t.gradient_to}44)` }}
                onClick={() => applyTemplate(t)}
              >
                <Badge variant="outline" className="text-[10px] mb-2">{t.category}</Badge>
                <p className="font-semibold text-sm">{t.name}</p>
                <p className="text-xs text-muted-foreground line-clamp-2 mt-1">{t.title}</p>
                <Badge className="mt-2 text-[10px]">Reusable</Badge>
              </button>
            ))}
          </div>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <BarChart3 className="h-5 w-5" />
            History & Analytics
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loadingCampaigns ? (
            <Loader2 className="h-6 w-6 animate-spin" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Campaign</TableHead>
                  <TableHead>Target</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Sent</TableHead>
                  <TableHead>Opened</TableHead>
                  <TableHead>Tapped</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {campaigns.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>
                      <p className="font-medium">{c.title}</p>
                      <p className="text-xs text-muted-foreground">{c.category}</p>
                    </TableCell>
                    <TableCell>{c.target_app} · {c.target_scope}</TableCell>
                    <TableCell><Badge variant="outline">{c.status}</Badge></TableCell>
                    <TableCell>{c.delivered_count}/{c.sent_count}</TableCell>
                    <TableCell>{c.opened_count}</TableCell>
                    <TableCell>{c.tapped_count}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {format(new Date(c.created_at), "MMM d, HH:mm")}
                    </TableCell>
                    <TableCell>
                      {(c.status === "draft" || c.status === "scheduled") && (
                        <Button size="sm" variant="outline" disabled={isSaving} onClick={() => sendExisting(c.id)}>
                          Send
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
                {campaigns.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center text-muted-foreground py-8">
                      No campaigns yet
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
