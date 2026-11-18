import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import {
  validateCampaignDraft,
  type DriverTripBonusCampaignRow,
  type TripBonusCampaignStatus,
  type TripBonusScopeType,
} from '../../shared/driverTripBonusCampaignSSOT';

export type TripBonusCampaignWithAreas = DriverTripBonusCampaignRow & {
  service_area_ids: string[];
};

const db = supabase as any;

export function useDriverTripBonusCampaignsAdmin() {
  return useQuery({
    queryKey: ['driver-trip-bonus-campaigns'],
    queryFn: async (): Promise<TripBonusCampaignWithAreas[]> => {
      const { data, error } = await db
        .from('driver_trip_bonus_campaigns')
        .select(
          'id, title, card_headline, card_body, trip_target, bonus_amount_pence, status, is_active, starts_at, ends_at, scope_type, region_id, display_priority, created_at',
        )
        .order('display_priority', { ascending: false })
        .order('created_at', { ascending: false });
      if (error) throw error;
      const rows = (data ?? []) as DriverTripBonusCampaignRow[];
      if (!rows.length) return [];

      const { data: links } = await db
        .from('driver_trip_bonus_campaign_service_areas')
        .select('campaign_id, service_area_id')
        .in(
          'campaign_id',
          rows.map((r) => r.id),
        );

      const map = new Map<string, string[]>();
      (links ?? []).forEach((l: { campaign_id: string; service_area_id: string }) => {
        const arr = map.get(l.campaign_id) ?? [];
        arr.push(l.service_area_id);
        map.set(l.campaign_id, arr);
      });

      return rows.map((r) => ({ ...r, service_area_ids: map.get(r.id) ?? [] }));
    },
    staleTime: 30_000,
  });
}

export function useSaveDriverTripBonusCampaign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      id?: string;
      title: string;
      card_headline: string;
      card_body: string;
      trip_target: number;
      bonus_amount_pence: number;
      status: TripBonusCampaignStatus;
      is_active: boolean;
      starts_at: string | null;
      ends_at: string | null;
      scope_type: TripBonusScopeType;
      region_id: string | null;
      display_priority: number;
      service_area_ids: string[];
    }) => {
      const { data, error } = await db.rpc('admin_save_driver_trip_bonus_campaign', {
        p_campaign: {
          id: input.id ?? null,
          title: input.title,
          card_headline: input.card_headline,
          card_body: input.card_body || null,
          trip_target: input.trip_target,
          bonus_amount_pence: input.bonus_amount_pence,
          status: input.status,
          is_active: input.is_active,
          starts_at: input.starts_at,
          ends_at: input.ends_at,
          scope_type: input.scope_type,
          region_id: input.region_id,
          display_priority: input.display_priority,
        },
        p_service_area_ids: input.service_area_ids,
      });
      if (error) throw error;
      return data as string;
    },
    onSuccess: () => {
      toast.success('Trip bonus campaign saved');
      qc.invalidateQueries({ queryKey: ['driver-trip-bonus-campaigns'] });
    },
    onError: (err: Error) => {
      toast.error(err.message || 'Failed to save campaign');
    },
  });
}

export function useArchiveDriverTripBonusCampaign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await db
        .from('driver_trip_bonus_campaigns')
        .update({ status: 'archived', is_active: false, updated_at: new Date().toISOString() })
        .eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Campaign archived');
      qc.invalidateQueries({ queryKey: ['driver-trip-bonus-campaigns'] });
    },
    onError: (err: Error) => {
      toast.error(err.message || 'Failed to archive');
    },
  });
}

/** Publish a draft via the same gated save RPC — preserves Active, dates, and scope. */
export function usePublishDriverTripBonusCampaign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (campaign: TripBonusCampaignWithAreas) => {
      if (campaign.status !== 'draft') {
        throw new Error('Only draft campaigns can be published');
      }
      const errors = validateCampaignDraft({
        title: campaign.title,
        card_headline: campaign.card_headline,
        trip_target: campaign.trip_target,
        bonus_amount_pence: campaign.bonus_amount_pence,
        scope_type: campaign.scope_type,
        region_id: campaign.region_id,
        service_area_ids: campaign.service_area_ids ?? [],
      });
      if (errors.length) {
        throw new Error(`Cannot publish: ${errors.join(', ')}`);
      }
      const { data, error } = await db.rpc('admin_save_driver_trip_bonus_campaign', {
        p_campaign: {
          id: campaign.id,
          title: campaign.title,
          card_headline: campaign.card_headline,
          card_body: campaign.card_body,
          trip_target: campaign.trip_target,
          bonus_amount_pence: campaign.bonus_amount_pence,
          status: 'published',
          is_active: campaign.is_active,
          starts_at: campaign.starts_at,
          ends_at: campaign.ends_at,
          scope_type: campaign.scope_type,
          region_id: campaign.region_id,
          display_priority: campaign.display_priority,
        },
        p_service_area_ids: campaign.service_area_ids ?? [],
      });
      if (error) throw error;
      return data as string;
    },
    onSuccess: () => {
      toast.success('Campaign published');
      qc.invalidateQueries({ queryKey: ['driver-trip-bonus-campaigns'] });
    },
    onError: (err: Error) => {
      toast.error(err.message || 'Failed to publish campaign');
    },
  });
}
