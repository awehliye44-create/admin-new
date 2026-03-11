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
  is_active: boolean;
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

export function StaffProfileProvider({ children }: { children: ReactNode }) {
  const { user, isAuthReady } = useAuth();
  const [staffProfile, setStaffProfile] = useState<StaffProfile | null>(null);
  const [allowedPages, setAllowedPages] = useState<Set<string>>(new Set());
  const [assignedServiceAreas, setAssignedServiceAreas] = useState<StaffServiceArea[]>([]);
  const [isStaffLoading, setIsStaffLoading] = useState(true);

  const fetchStaffData = useCallback(async () => {
    if (!user) {
      setStaffProfile(null);
      setAllowedPages(new Set());
      setAssignedServiceAreas([]);
      setIsStaffLoading(false);
      return;
    }

    setIsStaffLoading(true);
    try {
      // Fetch staff profile
      const { data: profile } = await supabase
        .from('staff_profiles')
        .select('*')
        .eq('user_id', user.id)
        .eq('is_active', true)
        .maybeSingle();

      if (!profile) {
        // No staff profile - user has admin role in user_roles (backward compat)
        // Give them full access as super_admin
        setStaffProfile(null);
        const { data: allPerms } = await supabase
          .from('role_page_permissions')
          .select('page_slug')
          .eq('role', 'super_admin' as any)
          .eq('can_access', true);
        setAllowedPages(new Set((allPerms || []).map(p => p.page_slug)));
        setAssignedServiceAreas([]);
        setIsStaffLoading(false);
        return;
      }

      setStaffProfile(profile as unknown as StaffProfile);

      // Fetch page permissions for this role
      const { data: perms } = await supabase
        .from('role_page_permissions')
        .select('page_slug')
        .eq('role', profile.role as any)
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
  }, [user]);

  useEffect(() => {
    if (isAuthReady) {
      fetchStaffData();
    }
  }, [isAuthReady, fetchStaffData]);

  const canAccessPage = useCallback(
    (pageSlug: string) => {
      // While loading, allow access to prevent flashing
      if (isStaffLoading) return true;
      // No staff profile but has admin role → full access (backward compat)
      if (!staffProfile && allowedPages.size > 0) return true;
      if (!staffProfile) return true; // No restrictions if no staff system set up
      // Profile page always accessible
      if (pageSlug === 'profile') return true;
      return allowedPages.has(pageSlug);
    },
    [staffProfile, allowedPages, isStaffLoading]
  );

  const canManageRoles = staffProfile
    ? ['super_admin', 'admin'].includes(staffProfile.role)
    : true; // backward compat

  return (
    <StaffProfileContext.Provider
      value={{
        staffProfile,
        allowedPages,
        assignedServiceAreas,
        isStaffLoading,
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
