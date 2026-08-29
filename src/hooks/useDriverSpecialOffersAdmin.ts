import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import type { DriverSpecialOfferRow } from '../../shared/driverSpecialOffersSSOT';

export type { DriverSpecialOfferRow };

/** Offers are strictly separated per app audience — driver offers never reach customers. */
export type OfferAudience = 'driver' | 'customer';

export interface SpecialOfferCategoryRow {
  id: string;
  name: string;
  badge_label: string | null;
  display_order: number;
  is_active: boolean;
  audience: OfferAudience;
}

export interface SpecialOfferWithAreas extends DriverSpecialOfferRow {
  service_area_ids: string[];
  audience: OfferAudience;
}

const db = supabase as any;

export function useSpecialOfferCategories(audience: OfferAudience) {
  return useQuery({
    queryKey: ['special-offer-categories', audience],
    queryFn: async (): Promise<SpecialOfferCategoryRow[]> => {
      const { data, error } = await db
        .from('driver_special_offer_categories')
        .select('id, name, badge_label, display_order, is_active, audience')
        .eq('audience', audience)
        .order('display_order', { ascending: true })
        .order('name', { ascending: true });
      if (error) throw error;
      return (data ?? []) as SpecialOfferCategoryRow[];
    },
    staleTime: 60_000,
  });
}

export function useSpecialOffersAdmin(audience: OfferAudience) {
  return useQuery({
    queryKey: ['special-offers', audience],
    queryFn: async (): Promise<SpecialOfferWithAreas[]> => {
      const { data, error } = await db
        .from('driver_special_offers')
        .select('id, category_id, title, partner_name, short_description, full_details, badge_label, image_path, website_url, phone_number, email_address, promo_code, internal_route, website_button_label, phone_button_label, email_button_label, banner_headline, banner_button_label, status, is_active, is_featured, show_in_home_banner, show_in_offer_list, starts_at, ends_at, minimum_completed_trips, new_drivers_only, eligible_driver_tiers, display_order, scope_type, region_id, created_at, audience')
        .eq('audience', audience)
        .order('is_featured', { ascending: false })
        .order('display_order', { ascending: true })
        .order('title', { ascending: true });
      if (error) throw error;
      const offers = (data ?? []) as SpecialOfferWithAreas[];
      if (!offers.length) return [];

      const { data: links } = await db
        .from('driver_special_offer_service_areas')
        .select('offer_id, service_area_id')
        .in('offer_id', offers.map((o) => o.id));

      const map = new Map<string, string[]>();
      (links ?? []).forEach((l: any) => {
        const arr = map.get(l.offer_id) ?? [];
        arr.push(l.service_area_id);
        map.set(l.offer_id, arr);
      });

      return offers.map((o) => ({ ...o, service_area_ids: map.get(o.id) ?? [] }));
    },
    staleTime: 30_000,
  });
}

function useInvalidateOffers(audience: OfferAudience) {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ['special-offers', audience] });
    qc.invalidateQueries({ queryKey: ['special-offer-categories', audience] });
  };
}

export function useSaveSpecialOfferCategory(audience: OfferAudience) {
  const invalidate = useInvalidateOffers(audience);
  return useMutation({
    mutationFn: async (input: Partial<SpecialOfferCategoryRow> & { id?: string }) => {
      if (input.id) {
        const { audience: _ignored, ...patch } = input;
        const { error } = await db.from('driver_special_offer_categories').update(patch).eq('id', input.id);
        if (error) throw error;
      } else {
        const { error } = await db.from('driver_special_offer_categories').insert({ ...input, audience });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      toast.success('Category saved');
      invalidate();
    },
    onError: (e: any) => toast.error(e.message ?? 'Failed to save category'),
  });
}

export function useDeleteSpecialOfferCategory(audience: OfferAudience) {
  const invalidate = useInvalidateOffers(audience);
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await db.from('driver_special_offer_categories').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Category deleted');
      invalidate();
    },
    onError: (e: any) => toast.error(e.message ?? 'Failed to delete category'),
  });
}

export function useSaveSpecialOffer(audience: OfferAudience) {
  const invalidate = useInvalidateOffers(audience);
  return useMutation({
    mutationFn: async ({
      serviceAreaIds,
      ...input
    }: Partial<DriverSpecialOfferRow> & { id?: string; serviceAreaIds: string[] }) => {
      // Single transactional backend save: offer + service-area assignments are
      // validated together by the availability-area triggers.
      const { data, error } = await db.rpc('admin_save_driver_special_offer', {
        p_offer: { ...input, audience },
        p_service_area_ids: input.scope_type === 'selected_service_areas' ? serviceAreaIds : [],
      });
      if (error) throw error;
      return data as string;
    },
    onSuccess: () => {
      toast.success('Offer saved');
      invalidate();
    },
    onError: (e: any) => toast.error(e.message ?? 'Failed to save offer'),
  });
}

export function useDeleteSpecialOffer(audience: OfferAudience) {
  const invalidate = useInvalidateOffers(audience);
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await db.from('driver_special_offers').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Offer deleted');
      invalidate();
    },
    onError: (e: any) => toast.error(e.message ?? 'Failed to delete offer'),
  });
}

/** Driver tiers SSOT for eligibility selection (driver audience only). */
export function useDriverTierNames(enabled = true) {
  return useQuery({
    queryKey: ['driver-tier-names'],
    enabled,
    queryFn: async (): Promise<string[]> => {
      const { data, error } = await db
        .from('driver_categories')
        .select('name, level_order')
        .eq('is_active', true)
        .order('level_order', { ascending: true });
      if (error) throw error;
      return (data ?? []).map((r: any) => r.name as string);
    },
    staleTime: 300_000,
  });
}
