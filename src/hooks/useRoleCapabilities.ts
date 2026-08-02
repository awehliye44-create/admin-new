import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { useStaffProfile } from '@/hooks/useStaffProfile';
import {
  ActorContext,
  StaffRoleKey,
  actorHasAction,
  isReadOnlyActor,
} from '../../shared/rolesPermissionsSSOT';

export interface RoleCapabilities {
  actor: ActorContext;
  isLoading: boolean;
  isReadOnly: boolean;
  activeSuperAdminCount: number;
  has: (key: string) => boolean;
  refetch: () => Promise<void>;
}

/**
 * Resolves the signed-in admin's action-level capabilities.
 * Backend RPCs remain the enforcement authority — this only drives the UI.
 */
export function useRoleCapabilities(): RoleCapabilities {
  const { user } = useAuth();
  const { staffProfile, allowedPages, isStaffLoading } = useStaffProfile();
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  const [allowedActions, setAllowedActions] = useState<string[]>([]);
  const [activeSuperAdminCount, setActiveSuperAdminCount] = useState(0);
  const [isLoading, setIsLoading] = useState(true);

  const userId = user?.id;
  const role = (staffProfile?.role ?? null) as StaffRoleKey | null;

  const load = useCallback(async () => {
    if (!userId) {
      setIsLoading(false);
      return;
    }
    try {
      const [superRes, countRes, actionsRes] = await Promise.all([
        supabase.rpc('is_super_admin', { _user_id: userId }),
        supabase.rpc('active_super_admin_count'),
        role
          ? supabase
              .from('role_action_permissions')
              .select('action_key, is_allowed')
              .eq('role', role)
              .eq('is_allowed', true)
          : Promise.resolve({ data: [] as { action_key: string }[] } as never),
      ]);

      setIsSuperAdmin(Boolean(superRes.data));
      setActiveSuperAdminCount(Number(countRes.data ?? 0));
      setAllowedActions(
        ((actionsRes as { data?: { action_key: string }[] }).data ?? []).map((r) => r.action_key),
      );
    } catch (err) {
      console.error('[useRoleCapabilities] failed to load capabilities', err);
      setIsSuperAdmin(false);
      setAllowedActions([]);
    } finally {
      setIsLoading(false);
    }
  }, [userId, role]);

  useEffect(() => {
    if (!isStaffLoading) void load();
  }, [isStaffLoading, load]);

  const actor: ActorContext = {
    role,
    isSuperAdmin,
    allowedActions,
    allowedPages: Array.from(allowedPages),
  };

  return {
    actor,
    isLoading: isLoading || isStaffLoading,
    isReadOnly: isReadOnlyActor(actor),
    activeSuperAdminCount,
    has: (key: string) => actorHasAction(actor, key),
    refetch: load,
  };
}
