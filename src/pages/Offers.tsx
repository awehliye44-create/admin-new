import { useState, useMemo } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AdminLayout } from "@/components/layout/AdminLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useAdminOffers, type OfferWithAreas } from "@/hooks/useOffers";
import { OfferFormDialog } from "@/components/offers/OfferFormDialog";
import { supabase } from "@/integrations/supabase/client";
import { useServiceAreasMap } from "@/hooks/useServiceAreas";
import { toast } from "sonner";
import { Plus, Search, Pencil, Trash2, Sparkles, Percent, PoundSterling, TrendingUp, Globe } from "lucide-react";
import { format } from "date-fns";

export default function Offers() {
  const qc = useQueryClient();
  const { data: offers = [], isLoading } = useAdminOffers();
  const { map: areaMap } = useServiceAreasMap();
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<OfferWithAreas | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<OfferWithAreas | null>(null);

  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    if (!s) return offers;
    return offers.filter(
      (o) => o.name.toLowerCase().includes(s) || o.code.toLowerCase().includes(s)
    );
  }, [offers, search]);

  const stats = useMemo(() => ({
    total: offers.length,
    active: offers.filter((o) => o.is_enabled && o.status === "active").length,
    redemptions: offers.reduce((s, o) => s + o.redemption_count, 0),
  }), [offers]);

  const toggleEnabled = useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) => {
      const { error } = await supabase.from("offers" as any).update({ is_enabled: enabled }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-offers"] }),
    onError: (e: any) => toast.error(e.message ?? "Failed to toggle"),
  });

  const removeOffer = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("offers" as any).delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-offers"] });
      toast.success("Offer deleted");
    },
    onError: (e: any) => toast.error(e.message ?? "Failed to delete"),
  });

  const openCreate = () => { setEditing(null); setDialogOpen(true); };
  const openEdit = (o: OfferWithAreas) => { setEditing(o); setDialogOpen(true); };

  return (
    <AdminLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold flex items-center gap-2">
              <Sparkles className="h-6 w-6 text-primary" /> Customer Offers
            </h1>
            <p className="text-sm text-muted-foreground">
              Admin-controlled promotions shown on the customer home screen and applied to bookings.
            </p>
          </div>
          <Button onClick={openCreate}><Plus className="h-4 w-4" /> New offer</Button>
        </div>

        <div className="grid gap-3 md:grid-cols-3">
          <StatCard icon={<Sparkles className="h-4 w-4" />} label="Total offers" value={stats.total} />
          <StatCard icon={<TrendingUp className="h-4 w-4" />} label="Active right now" value={stats.active} />
          <StatCard icon={<Percent className="h-4 w-4" />} label="Total redemptions" value={stats.redemptions} />
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">All offers</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="mb-3 flex items-center gap-2">
              <div className="relative flex-1 max-w-sm">
                <Search className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  className="pl-8"
                  placeholder="Search by name or code…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
            </div>

            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Code</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Discount</TableHead>
                    <TableHead>Service areas</TableHead>
                    <TableHead>Window</TableHead>
                    <TableHead>Usage</TableHead>
                    <TableHead>Enabled</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {isLoading && (
                    <TableRow><TableCell colSpan={9} className="text-center text-muted-foreground py-6">Loading…</TableCell></TableRow>
                  )}
                  {!isLoading && filtered.length === 0 && (
                    <TableRow><TableCell colSpan={9} className="text-center text-muted-foreground py-6">No offers yet. Click “New offer” to create one.</TableCell></TableRow>
                  )}
                  {filtered.map((o) => (
                    <TableRow key={o.id}>
                      <TableCell>
                        <div className="font-medium">{o.name}</div>
                        <div className="text-xs text-muted-foreground line-clamp-1">{o.banner_title}</div>
                      </TableCell>
                      <TableCell><Badge variant="outline">{o.code}</Badge></TableCell>
                      <TableCell>
                        {o.offer_type === "percent_discount" ? (
                          <span className="inline-flex items-center gap-1 text-sm"><Percent className="h-3 w-3" /> Percent</span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-sm"><PoundSterling className="h-3 w-3" /> Fixed</span>
                        )}
                      </TableCell>
                      <TableCell className="font-medium">
                        {o.offer_type === "percent_discount"
                          ? `${Number(o.discount_value)}%`
                          : `${o.currency} ${Number(o.discount_value).toFixed(2)}`}
                      </TableCell>
                      <TableCell>
                        {o.service_area_ids.length === 0 ? (
                          <Badge variant="secondary" className="gap-1"><Globe className="h-3 w-3" /> All areas</Badge>
                        ) : (
                          <span className="text-xs">
                            {o.service_area_ids.slice(0, 2).map((id) => areaMap.get(id)?.name ?? "—").join(", ")}
                            {o.service_area_ids.length > 2 && ` +${o.service_area_ids.length - 2}`}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-xs">
                        <div>From {format(new Date(o.starts_at), "dd MMM")}</div>
                        <div className="text-muted-foreground">{o.ends_at ? `To ${format(new Date(o.ends_at), "dd MMM")}` : "No end"}</div>
                      </TableCell>
                      <TableCell className="text-sm">
                        {o.usage_count}
                        {o.total_usage_limit ? ` / ${o.total_usage_limit}` : ""}
                      </TableCell>
                      <TableCell>
                        <Switch
                          checked={o.is_enabled}
                          onCheckedChange={(v) => toggleEnabled.mutate({ id: o.id, enabled: v })}
                        />
                      </TableCell>
                      <TableCell className="text-right">
                        <Button size="icon" variant="ghost" onClick={() => openEdit(o)}><Pencil className="h-4 w-4" /></Button>
                        <Button size="icon" variant="ghost" onClick={() => setConfirmDelete(o)}><Trash2 className="h-4 w-4" /></Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </div>

      <OfferFormDialog open={dialogOpen} onOpenChange={setDialogOpen} offer={editing} />

      <AlertDialog open={!!confirmDelete} onOpenChange={(v) => !v && setConfirmDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete offer?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete “{confirmDelete?.name}”. Past redemptions are preserved.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirmDelete) removeOffer.mutate(confirmDelete.id);
                setConfirmDelete(null);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AdminLayout>
  );
}

function StatCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <Card>
      <CardContent className="flex items-center justify-between p-4">
        <div>
          <div className="text-xs text-muted-foreground">{label}</div>
          <div className="text-2xl font-semibold">{value}</div>
        </div>
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">{icon}</div>
      </CardContent>
    </Card>
  );
}
