import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export type OfferType = "percent_discount" | "fixed_amount_discount";
export type OfferStatus = "draft" | "active" | "archived";

export interface Offer {
  id: string;
  name: string;
  code: string;
  description: string | null;
  offer_type: OfferType;
  discount_value: number;
  currency: string;
  min_fare_pence: number;
  max_discount_pence: number | null;
  starts_at: string;
  ends_at: string | null;
  is_enabled: boolean;
  status: OfferStatus;
  first_ride_only: boolean;
  new_customer_only: boolean;
  per_user_limit: number | null;
  total_usage_limit: number | null;
  usage_count: number;
  priority: number;
  terms: string | null;
  banner_title: string;
  banner_subtitle: string | null;
  cta_text: string;
  badge_text: string | null;
  style_variant: string;
  created_at: string;
  updated_at: string;
}

export interface OfferWithAreas extends Offer {
  service_area_ids: string[];
  redemption_count: number;
}

/** Admin: list ALL offers with their service-area links + redemption counts. */
export function useAdminOffers() {
  return useQuery({
    queryKey: ["admin-offers"],
    queryFn: async (): Promise<OfferWithAreas[]> => {
      const { data: offers, error } = await supabase
        .from("offers" as any)
        .select("*")
        .order("priority", { ascending: false })
        .order("created_at", { ascending: false });
      if (error) throw error;

      const ids = (offers ?? []).map((o: any) => o.id);
      if (!ids.length) return [];

      const [{ data: links }, { data: reds }] = await Promise.all([
        supabase.from("offer_service_areas" as any).select("offer_id, service_area_id").in("offer_id", ids),
        supabase.from("offer_redemptions" as any).select("offer_id").in("offer_id", ids),
      ]);

      const linkMap = new Map<string, string[]>();
      (links ?? []).forEach((l: any) => {
        const arr = linkMap.get(l.offer_id) ?? [];
        arr.push(l.service_area_id);
        linkMap.set(l.offer_id, arr);
      });
      const redCount = new Map<string, number>();
      (reds ?? []).forEach((r: any) => redCount.set(r.offer_id, (redCount.get(r.offer_id) ?? 0) + 1));

      return (offers ?? []).map((o: any) => ({
        ...(o as Offer),
        service_area_ids: linkMap.get(o.id) ?? [],
        redemption_count: redCount.get(o.id) ?? 0,
      }));
    },
    staleTime: 30_000,
  });
}

/** Customer-app facing: active offers visible to the current user for a service area. */
export function useActiveOffersForArea(serviceAreaId?: string | null) {
  return useQuery({
    queryKey: ["active-offers", serviceAreaId ?? "none"],
    enabled: !!serviceAreaId,
    queryFn: async (): Promise<Offer[]> => {
      const nowIso = new Date().toISOString();
      const { data: offers, error } = await supabase
        .from("offers" as any)
        .select("*")
        .eq("is_enabled", true)
        .eq("status", "active")
        .lte("starts_at", nowIso)
        .or(`ends_at.is.null,ends_at.gt.${nowIso}`)
        .order("priority", { ascending: false });
      if (error) throw error;

      const list = (offers ?? []) as unknown as Offer[];
      if (!list.length) return [];

      // Filter by service area: an offer with no rows in offer_service_areas = global.
      const ids = list.map((o) => o.id);
      const { data: links } = await supabase
        .from("offer_service_areas" as any)
        .select("offer_id, service_area_id")
        .in("offer_id", ids);
      const scopeMap = new Map<string, Set<string>>();
      (links ?? []).forEach((l: any) => {
        const set = scopeMap.get(l.offer_id) ?? new Set();
        set.add(l.service_area_id);
        scopeMap.set(l.offer_id, set);
      });

      return list.filter((o) => {
        const scope = scopeMap.get(o.id);
        if (!scope || scope.size === 0) return true; // global
        return serviceAreaId ? scope.has(serviceAreaId) : false;
      });
    },
    staleTime: 60_000,
  });
}
