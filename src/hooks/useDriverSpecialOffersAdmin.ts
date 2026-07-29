import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import type { DriverSpecialOfferRow } from '../../shared/driverSpecialOffersSSOT';

export type { DriverSpecialOfferRow };

export interface SpecialOfferCategoryRow {
  id: string;
  name: string;
  badge_label: string | null;
  display_order: number;
  is_active: boolean;
}

export interface SpecialOfferWithAreas extends DriverSpecialOfferRow {
  service_area_ids: string[];
}

const db = supabase as any;

export function useSpecialOfferCategories() {
  return useQuery({
    queryKey: ['special-offer-categories'],
    queryFn: async (): Promise<SpecialOfferCategoryRow[]> => {
      const { data, error } = await db
        .from('driver_special_offer_categories')
        .select('*')
        .order('display_order', { ascending: true })
        .order('name', { ascending: true });
      if (error) throw error;
      return (data ?? []) as SpecialOfferCategoryRow[];
    },
    staleTime: 60_000,
  });
}

export function useDriverSpecialOffersAdmin() {
  return useQuery({
    queryKey: ['driver-special-offers'],
    queryFn: async (): Promise<SpecialOfferWithAreas[]> => {
      const { data, error } = await db
        .from('driver_special_offers')
        .select('*')
        .order('is_featured', { ascending: false })
        .order('display_order', { ascending: true })
        .order('title', { ascending: true });
      if (error) throw error;
      const offers = (data ?? []) as DriverSpecialOfferRow[];
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

function useInvalidateOffers() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ['driver-special-offers'] });
    qc.invalidateQueries({ queryKey: ['special-offer-categories'] });
  };
}

export function useSaveSpecialOfferCategory() {
  const invalidate = useInvalidateOffers();
  return useMutation({
    mutationFn: async (input: Partial<SpecialOfferCategoryRow> & { id?: string }) => {
      if (input.id) {
        const { error } = await db.from('driver_special_offer_categories').update(input).eq('id', input.id);
        if (error) throw error;
      } else {
        const { error } = await db.from('driver_special_offer_categories').insert(input);
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

export function useDeleteSpecialOfferCategory() {
  const invalidate = useInvalidateOffers();
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

export function useSaveSpecialOffer() {
  const invalidate = useInvalidateOffers();
  return useMutation({
    mutationFn: async ({
      serviceAreaIds,
      ...input
    }: Partial<DriverSpecialOfferRow> & { id?: string; serviceAreaIds: string[] }) => {
      const { data: auth } = await supabase.auth.getUser();
      const payload = { ...input, updated_by: auth.user?.id ?? null };
      let offerId = input.id;

      if (offerId) {
        const { error } = await db.from('driver_special_offers').update(payload).eq('id', offerId);
        if (error) throw error;
      } else {
        const { data, error } = await db
          .from('driver_special_offers')
          .insert({ ...payload, created_by: auth.user?.id ?? null })
          .select('id')
          .single();
        if (error) throw error;
        offerId = data.id;
      }

      const { error: delErr } = await db
        .from('driver_special_offer_service_areas')
        .delete()
        .eq('offer_id', offerId);
      if (delErr) throw delErr;

      if (serviceAreaIds.length) {
        const { error: insErr } = await db
          .from('driver_special_offer_service_areas')
          .insert(serviceAreaIds.map((service_area_id) => ({ offer_id: offerId, service_area_id })));
        if (insErr) throw insErr;
      }
    },
    onSuccess: () => {
      toast.success('Offer saved');
      invalidate();
    },
    onError: (e: any) => toast.error(e.message ?? 'Failed to save offer'),
  });
}

export function useDeleteSpecialOffer() {
  const invalidate = useInvalidateOffers();
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

/** Driver tiers SSOT for eligibility selection. */
export function useDriverTierNames() {
  return useQuery({
    queryKey: ['driver-tier-names'],
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
