import { useState, useEffect, useCallback, createContext, useContext, ReactNode } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { isCatalogPageSlug } from '../../shared/adminPageCatalogSSOT';

export type StaffRole = 'super_admin' | 'admin' | 'operator' | 'finance_manager' | 'customer_support' | 'compliance_officer';

export interface StaffProfile {
  id: string;
  user_id: string;
  staff_role_id: string;
  full_name: string;
  username: string | null;
  role: StaffRole;
  role_id: string;
  role_name?: string;
  is_active: boolean;
  is_owner?: boolean;
  created_at: string;
}

export interface StaffServiceArea {
  id: string;
  service_area_id: string;
  service_area_name?: string;
}

/** Staff permission load outcome — fail closed unless `ready` with a profile. */
export type StaffAccessStatus =
  | 'loading'
  | 'ready'
  | 'missing_profile'
  | 'inactive'
  | 'fetch_error';

interface StaffProfileContextType {
  staffProfile: StaffProfile | null;
  allowedPages: Set<string>;
  assignedServiceAreas: StaffServiceArea[];
  isStaffLoading: boolean;
  staffAccessStatus: StaffAccessStatus;
  staffAccessError: string | null;
  isOwner: boolean;
  canAccessPage: (pageSlug: string) => boolean;
  canManageRoles: boolean;
  refetch: () => Promise<void>;
}

const StaffProfileContext = createContext<StaffProfileContextType | undefined>(undefined);

const ROLE_LABELS: Record<StaffRole, string> = {
  super_admin: 'Super Admin',
  admin: 'Admin',
  operator: 'Operator',
  finance_manager: 'Finance Manager',
  customer_support: 'Customer Support',
  compliance_officer: 'Compliance Officer',
};

const ROLE_PREFIXES: Record<StaffRole, string> = {
  super_admin: 'SA',
  admin: 'AD',
  operator: 'OP',
  finance_manager: 'FM',
  customer_support: 'CS',
  compliance_officer: 'CO',
};

export { ROLE_LABELS, ROLE_PREFIXES };

export interface ResolvePageAccessOpts {
  isLoading: boolean;
  profile: Pick<StaffProfile, 'is_owner'> | null;
  allowedPages: Set<string>;
  /** When true (fetch failed / missing profile), deny all non-owner access. */
  failClosed?: boolean;
}

/**
 * Pure page-access rule shared by the sidebar and the page gate.
 *
 * Exceptions (explicit, minimal):
 *  1. Owner (`is_owner`) → every page, including Roles & Permissions
 *  2. `roles` → Owner only (non-owners denied even if the DB row is granted)
 *  3. Path redirects normalize to a canonical slug before calling this
 *     (see `resolvePermissionSlugFromPath`) — not alias expansion
 *
 * `/profile` requires an explicit matrix grant (same as any other page).
 * Unknown / non-catalog slugs are denied to non-owners.
 */
export function resolvePageAccess(pageSlug: string, opts: ResolvePageAccessOpts): boolean {
  const { isLoading, profile, allowedPages, failClosed = false } = opts;

  // Fail closed while loading — ProtectedRoute waits for staff load before shell.
  if (isLoading) return false;

  if (profile?.is_owner === true) return true;

  // Roles & Permissions is reserved for the single ONECAB Owner
  if (pageSlug === 'roles') return false;

  if (failClosed || !profile) return false;

  // Unknown routes are not assignable → deny non-owners
  if (!isCatalogPageSlug(pageSlug)) return false;

  // Exact slug match only — one matrix tick grants one page
  return allowedPages.has(pageSlug);
}

export function StaffProfileProvider({ children }: { children: ReactNode }) {
  const { user, isAuthReady } = useAuth();
  const [staffProfile, setStaffProfile] = useState<StaffProfile | null>(null);
  const [allowedPages, setAllowedPages] = useState<Set<string>>(new Set());
  const [assignedServiceAreas, setAssignedServiceAreas] = useState<StaffServiceArea[]>([]);
  const [isStaffLoading, setIsStaffLoading] = useState(true);
  const [staffAccessStatus, setStaffAccessStatus] = useState<StaffAccessStatus>('loading');
  const [staffAccessError, setStaffAccessError] = useState<string | null>(null);

  const userId = user?.id;

  const fetchStaffData = useCallback(async () => {
    if (!userId) {
      setStaffProfile(null);
      setAllowedPages(new Set());
      setAssignedServiceAreas([]);
      setStaffAccessStatus('loading');
      setStaffAccessError(null);
      setIsStaffLoading(false);
      return;
    }

    setIsStaffLoading(true);
    setStaffAccessError(null);

    try {
      const { data: profile, error: profileError } = await supabase
        .from('staff_profiles')
        .select('id, user_id, staff_role_id, full_name, username, role, role_id, is_active, is_owner, created_at, staff_roles_catalog(name)')
        .eq('user_id', userId)
        .maybeSingle();

      if (profileError) {
        console.error('Error loading staff profile:', profileError);
        setStaffProfile(null);
        setAllowedPages(new Set());
        setAssignedServiceAreas([]);
        setStaffAccessStatus('fetch_error');
        setStaffAccessError(profileError.message || 'Failed to load staff profile');
        setIsStaffLoading(false);
        return;
      }

      if (!profile) {
        // Authenticated admin without a staff_profiles row — fail closed
        setStaffProfile(null);
        setAllowedPages(new Set());
        setAssignedServiceAreas([]);
        setStaffAccessStatus('missing_profile');
        setStaffAccessError(null);
        setIsStaffLoading(false);
        return;
      }

      if (profile.is_active === false) {
        setStaffProfile(profile as unknown as StaffProfile);
        setAllowedPages(new Set());
        setAssignedServiceAreas([]);
        setStaffAccessStatus('inactive');
        setStaffAccessError(null);
        setIsStaffLoading(false);
        return;
      }

      const resolvedProfile: StaffProfile = {
        ...(profile as unknown as StaffProfile),
        role_name: (profile as any).staff_roles_catalog?.name ?? undefined,
      };
      setStaffProfile(resolvedProfile);

      const { data: perms, error: permsError } = await supabase
        .from('role_page_permissions')
        .select('page_slug')
        .eq('role_id', (profile as any).role_id)
        .eq('can_access', true);

      if (permsError) {
        console.error('Error loading page permissions:', permsError);
        setAllowedPages(new Set());
        setAssignedServiceAreas([]);
        setStaffAccessStatus('fetch_error');
        setStaffAccessError(permsError.message || 'Failed to load page permissions');
        setIsStaffLoading(false);
        return;
      }

      setAllowedPages(new Set((perms || []).map((p) => p.page_slug)));

      const { data: sas, error: sasError } = await supabase
        .from('staff_service_areas')
        .select('id, service_area_id, service_areas(name)')
        .eq('staff_id', profile.id);

      if (sasError) {
        // Service areas are not page RBAC — log and continue with empty list
        console.error('Error loading staff service areas:', sasError);
        setAssignedServiceAreas([]);
      } else {
        setAssignedServiceAreas(
          (sas || []).map((sa: any) => ({
            id: sa.id,
            service_area_id: sa.service_area_id,
            service_area_name: sa.service_areas?.name || 'Unknown',
          })),
        );
      }

      setStaffAccessStatus('ready');
      setStaffAccessError(null);
    } catch (err) {
      console.error('Error loading staff profile:', err);
      setStaffProfile(null);
      setAllowedPages(new Set());
      setAssignedServiceAreas([]);
      setStaffAccessStatus('fetch_error');
      setStaffAccessError(err instanceof Error ? err.message : 'Failed to load staff permissions');
    } finally {
      setIsStaffLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    if (isAuthReady) {
      fetchStaffData();
    }
  }, [isAuthReady, fetchStaffData]);

  const isOwner = staffProfile?.is_owner === true;
  const failClosed =
    staffAccessStatus === 'missing_profile' ||
    staffAccessStatus === 'inactive' ||
    staffAccessStatus === 'fetch_error';

  const canAccessPage = useCallback(
    (pageSlug: string) =>
      resolvePageAccess(pageSlug, {
        isLoading: isStaffLoading,
        profile: staffProfile,
        allowedPages,
        failClosed,
      }),
    [staffProfile, allowedPages, isStaffLoading, failClosed],
  );

  const canManageRoles = staffProfile?.is_owner === true;

  return (
    <StaffProfileContext.Provider
      value={{
        staffProfile,
        allowedPages,
        assignedServiceAreas,
        isStaffLoading,
        staffAccessStatus,
        staffAccessError,
        isOwner,
        canAccessPage,
        canManageRoles,
        refetch: fetchStaffData,
      }}
    >
      {children}
    </StaffProfileContext.Provider>
  );
}

export function useStaffProfile() {
  const context = useContext(StaffProfileContext);
  if (context === undefined) {
    throw new Error('useStaffProfile must be used within a StaffProfileProvider');
  }
  return context;
}
