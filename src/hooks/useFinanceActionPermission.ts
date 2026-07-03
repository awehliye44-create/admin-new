import { useAuth } from '@/hooks/useAuth';
import { useStaffProfile } from '@/hooks/useStaffProfile';

const FINANCE_ACTION_ROLES = new Set(['super_admin', 'admin', 'finance_manager']);

/**
 * Finance payment actions (capture / refund / sync / notes) require admin + FR access.
 */
export function useFinanceActionPermission() {
  const { isAdmin } = useAuth();
  const { staffProfile, canAccessPage, isStaffLoading } = useStaffProfile();

  const hasFinanceRole =
    !staffProfile || FINANCE_ACTION_ROLES.has(staffProfile.role);

  const canUseFinanceActions =
    isAdmin
    && hasFinanceRole
    && canAccessPage('financial-reconciliation');

  return {
    canUseFinanceActions,
    isFinancePermissionLoading: isStaffLoading,
  };
}
