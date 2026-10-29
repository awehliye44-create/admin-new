import { useState, useEffect, useCallback, createContext, useContext, ReactNode } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';

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

interface StaffProfileContextType {
  staffProfile: StaffProfile | null;
  allowedPages: Set<string>;
  assignedServiceAreas: StaffServiceArea[];
  isStaffLoading: boolean;
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

/** Route/sidebar slugs that differ from role_page_permissions slugs */
const ROUTE_PERMISSION_ALIASES: Record<string, string[]> = {
  'payment-sessions': [
    'payment-sessions',
    'payments',
    'admin-payments',
  ],
  payments: ['payments', 'payment-sessions'],
  'payment-providers': ['payment-providers', 'integrations'],
  'financial-reconciliation': [
    'financial-reconciliation',
    'drivers-and-payouts',
    'admin-settlements',
  ],
  'annual-taxi-report': [
    'annual-taxi-report',
    'financial-reconciliation',
    'drivers-and-payouts',
    'admin-settlements',
  ],
  'onecab-revenue-profit': [
    'onecab-revenue-profit',
    'financial-reconciliation',
  ],
  'payout-batches': [
    'payout-batches',
    'payout-ledger',
    'connect-payout-lockdown',
    'drivers-and-payouts',
    'admin-settlements',
    'finance-ledger-transactions',
  ],
  'payout-ledger': [
    'payout-ledger',
    'payout-batches',
    'connect-payout-lockdown',
  ],
  'driver-wallet-ledger': [
    'driver-wallet-ledger',
    'finance-ledger-transactions',
    'driver-wallet',
  ],
};

/** Pure page-access rule shared by the sidebar and the page gate. */
export function resolvePageAccess(
  pageSlug: string,
  opts: { isLoading: boolean; profile: Pick<StaffProfile, 'is_owner'> | null; allowedPages: Set<string> },
): boolean {
  const { isLoading, profile, allowedPages } = opts;
  // While loading, allow access to prevent flashing — except the
  // owner-only Roles & Permissions page, which must never render early.
  if (isLoading) return pageSlug !== 'roles';
  // Owner has unrestricted access to every admin page
  if (profile?.is_owner === true) return true;
  // Roles & Permissions is reserved for the single ONECAB Owner
  if (pageSlug === 'roles') return false;
  // No staff profile → legacy admin without staff system (backward compat)
  if (!profile) return true;
  if (pageSlug === 'profile') return true;
  const slugsToCheck = ROUTE_PERMISSION_ALIASES[pageSlug] ?? [pageSlug];
  return slugsToCheck.some((slug) => allowedPages.has(slug));
}

export function StaffProfileProvider({ children }: { children: ReactNode }) {
  const { user, isAuthReady } = useAuth();
  const [staffProfile, setStaffProfile] = useState<StaffProfile | null>(null);
  const [allowedPages, setAllowedPages] = useState<Set<string>>(new Set());
  const [assignedServiceAreas, setAssignedServiceAreas] = useState<StaffServiceArea[]>([]);
  const [isStaffLoading, setIsStaffLoading] = useState(true);

  const userId = user?.id;

  const fetchStaffData = useCallback(async () => {
    if (!userId) {
      setStaffProfile(null);
      setAllowedPages(new Set());
      setAssignedServiceAreas([]);
      setIsStaffLoading(false);
      return;
    }

    // Only show loading on initial fetch, not background refreshes
    const isInitialLoad = !staffProfile && allowedPages.size === 0;
    if (isInitialLoad) setIsStaffLoading(true);
    try {
      // Fetch staff profile (including inactive — we explicitly check is_active below)
      const { data: profile } = await supabase
        .from('staff_profiles')
        .select('id, user_id, staff_role_id, full_name, username, role, role_id, is_active, is_owner, created_at, staff_roles_catalog(name)')
        .eq('user_id', userId)
        .maybeSingle();

      if (profile && profile.is_active === false) {
        // Suspended staff: deny all admin access, do NOT fall through to backward-compat super_admin
        setStaffProfile(profile as unknown as StaffProfile);
        setAllowedPages(new Set());
        setAssignedServiceAreas([]);
        setIsStaffLoading(false);
        return;
      }

      if (!profile) {
        // No staff profile - user has admin role in profiles (backward compat)
        // Give them full access as super_admin
        setStaffProfile(null);
        const { data: allPerms } = await supabase
          .from('role_page_permissions')
          .select('page_slug, staff_roles_catalog!inner(is_owner_role)')
          .eq('staff_roles_catalog.is_owner_role', true)
          .eq('can_access', true);
        setAllowedPages(new Set((allPerms || []).map(p => p.page_slug)));
        setAssignedServiceAreas([]);
        setIsStaffLoading(false);
        return;
      }

      setStaffProfile({
        ...(profile as unknown as StaffProfile),
        role_name: (profile as any).staff_roles_catalog?.name ?? undefined,
      });

      // Fetch page permissions for this role
      const { data: perms } = await supabase
        .from('role_page_permissions')
        .select('page_slug')
        .eq('role_id', (profile as any).role_id)
        .eq('can_access', true);

      setAllowedPages(new Set((perms || []).map(p => p.page_slug)));

      // Fetch assigned service areas
      const { data: sas } = await supabase
        .from('staff_service_areas')
        .select('id, service_area_id, service_areas(name)')
        .eq('staff_id', profile.id);

      setAssignedServiceAreas(
        (sas || []).map((sa: any) => ({
          id: sa.id,
          service_area_id: sa.service_area_id,
          service_area_name: sa.service_areas?.name || 'Unknown',
        }))
      );
    } catch (err) {
      console.error('Error loading staff profile:', err);
      // Fallback: give full access
      setAllowedPages(new Set());
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

  const canAccessPage = useCallback(
    (pageSlug: string) =>
      resolvePageAccess(pageSlug, { isLoading: isStaffLoading, profile: staffProfile, allowedPages }),
    [staffProfile, allowedPages, isStaffLoading]
  );

  const canManageRoles = staffProfile?.is_owner === true;

  return (
    <StaffProfileContext.Provider
      value={{
        staffProfile,
        allowedPages,
        assignedServiceAreas,
        isStaffLoading,
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
