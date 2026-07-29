import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import type { HelpArticleRow, HelpAudience, HelpCategoryRow } from '../../shared/helpCentreSSOT';

export type { HelpArticleRow, HelpAudience, HelpCategoryRow };

const db = supabase as any;

export function useHelpCategories(audience: HelpAudience) {
  return useQuery({
    queryKey: ['help-categories', audience],
    queryFn: async (): Promise<HelpCategoryRow[]> => {
      const { data, error } = await db
        .from('help_centre_categories')
        .select('*')
        .eq('audience', audience)
        .order('display_order', { ascending: true })
        .order('title', { ascending: true });
      if (error) throw error;
      return (data ?? []) as HelpCategoryRow[];
    },
    staleTime: 30_000,
  });
}

export function useHelpArticles(audience: HelpAudience) {
  return useQuery({
    queryKey: ['help-articles', audience],
    queryFn: async (): Promise<HelpArticleRow[]> => {
      const { data, error } = await db
        .from('help_centre_articles')
        .select('*')
        .eq('audience', audience)
        .order('is_featured', { ascending: false })
        .order('display_order', { ascending: true })
        .order('title', { ascending: true });
      if (error) throw error;
      return (data ?? []) as HelpArticleRow[];
    },
    staleTime: 30_000,
  });
}

function useInvalidate(audience: HelpAudience) {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ['help-categories', audience] });
    qc.invalidateQueries({ queryKey: ['help-articles', audience] });
  };
}

export function useSaveHelpCategory(audience: HelpAudience) {
  const invalidate = useInvalidate(audience);
  return useMutation({
    mutationFn: async (input: Partial<HelpCategoryRow> & { id?: string }) => {
      const payload = { ...input, audience };
      if (input.id) {
        const { error } = await db.from('help_centre_categories').update(payload).eq('id', input.id);
        if (error) throw error;
      } else {
        const { error } = await db.from('help_centre_categories').insert(payload);
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

export function useDeleteHelpCategory(audience: HelpAudience) {
  const invalidate = useInvalidate(audience);
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await db.from('help_centre_categories').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Category deleted');
      invalidate();
    },
    onError: (e: any) => toast.error(e.message ?? 'Failed to delete category'),
  });
}

export function useSaveHelpArticle(audience: HelpAudience) {
  const invalidate = useInvalidate(audience);
  return useMutation({
    mutationFn: async (input: Partial<HelpArticleRow> & { id?: string }) => {
      const { data: auth } = await supabase.auth.getUser();
      const payload: Record<string, unknown> = {
        ...input,
        audience,
        updated_by: auth.user?.id ?? null,
      };
      if (payload.status === 'published' && !payload.published_at) {
        payload.published_at = new Date().toISOString();
      }
      if (payload.status === 'draft') payload.published_at = null;
      if (input.id) {
        const { error } = await db.from('help_centre_articles').update(payload).eq('id', input.id);
        if (error) throw error;
      } else {
        const { error } = await db.from('help_centre_articles').insert(payload);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      toast.success('Article saved');
      invalidate();
    },
    onError: (e: any) => toast.error(e.message ?? 'Failed to save article'),
  });
}

export function useDeleteHelpArticle(audience: HelpAudience) {
  const invalidate = useInvalidate(audience);
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await db.from('help_centre_articles').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Article deleted');
      invalidate();
    },
    onError: (e: any) => toast.error(e.message ?? 'Failed to delete article'),
  });
}
