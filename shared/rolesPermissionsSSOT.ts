/**
 * ONECAB — Roles & Permissions SSOT
 *
 * Single source of truth for:
 *  - Action-level (capability) permission keys
 *  - Super Admin protection rules
 *  - Delegation / "cannot grant what you don't have" rules
 *  - Help copy used by the Admin Panel UI
 *
 * These are PURE functions. The backend (RPC + RLS) is the enforcement
 * authority — this module keeps the UI aligned with it and is unit tested.
 */

export type StaffRoleKey =
  | 'super_admin'
  | 'admin'
  | 'operator'
  | 'finance_manager'
  | 'customer_support'
  | 'compliance_officer';

export const PROTECTED_ROLE: StaffRoleKey = 'super_admin';

export const ROLES_ORDER: StaffRoleKey[] = [
  'super_admin',
  'admin',
  'operator',
  'finance_manager',
  'customer_support',
  'compliance_officer',
];

/* ------------------------------------------------------------------ */
/* Action permission keys                                              */
/* ------------------------------------------------------------------ */

export const ROLE_ACTION_KEYS = [
  'roles_permissions.view',
  'roles_permissions.create_role',
  'roles_permissions.edit_role',
  'roles_permissions.delete_role',
  'roles_permissions.assign_role',
  'roles_permissions.manage_permissions',
  'roles_permissions.assign_service_areas',
  'roles_permissions.view_audit_log',
] as const;

export type RoleActionKey = (typeof ROLE_ACTION_KEYS)[number];

/** Sensitive capabilities that require an explicit delegation confirmation. */
export const SENSITIVE_ACTION_KEYS: RoleActionKey[] = [
  'roles_permissions.create_role',
  'roles_permissions.edit_role',
  'roles_permissions.delete_role',
  'roles_permissions.assign_role',
  'roles_permissions.manage_permissions',
  'roles_permissions.assign_service_areas',
];

export function isSensitiveActionKey(key: string): boolean {
  return (SENSITIVE_ACTION_KEYS as string[]).includes(key);
}

export const ACTION_LABELS: Record<RoleActionKey, string> = {
  'roles_permissions.view': 'Can view the page',
  'roles_permissions.create_role': 'Can create roles',
  'roles_permissions.edit_role': 'Can edit roles',
  'roles_permissions.delete_role': 'Can delete roles',
  'roles_permissions.assign_role': 'Can assign roles',
  'roles_permissions.manage_permissions': 'Can change permissions',
  'roles_permissions.assign_service_areas': 'Can assign service areas',
  'roles_permissions.view_audit_log': 'Can view the audit log',
};

export const ACTION_HELP: Record<RoleActionKey, string> = {
  'roles_permissions.view':
    'Allows the role to open Roles & Permissions in read-only mode. It does not allow any change.',
  'roles_permissions.create_role':
    'Allows the role to create new staff records and role definitions.',
  'roles_permissions.edit_role':
    'Allows the role to edit staff details, suspend or re-activate staff, and change role definitions.',
  'roles_permissions.delete_role':
    'Allows the role to delete custom roles and remove staff members.',
  'roles_permissions.assign_role':
    'Allows the role to assign or reassign a staff member’s role. It never allows granting Super Admin.',
  'roles_permissions.manage_permissions':
    'Allows the role to tick or untick page and action permissions for other roles.',
  'roles_permissions.assign_service_areas':
    'Allows the role to add or remove the operating areas a staff member can work in.',
  'roles_permissions.view_audit_log':
    'Allows the role to review the history of role, permission and service-area changes.',
};

/** Granular capabilities for Driver Demand Zones (seeded in role_action_permissions). */
export const DEMAND_ZONE_ROLE_ACTION_KEYS = [
  'demand_zones.view',
  'demand_zones.recompute',
  'demand_zones.configure_heatmap',
  'demand_zones.configure_colours',
  'demand_zones.configure_surge',
  'demand_zones.view_audit',
] as const;

export type DemandZoneRoleActionKey = (typeof DEMAND_ZONE_ROLE_ACTION_KEYS)[number];

export const DEMAND_ZONE_ACTION_LABELS: Record<DemandZoneRoleActionKey, string> = {
  'demand_zones.view': 'View demand zones',
  'demand_zones.recompute': 'Recompute heat map',
  'demand_zones.configure_heatmap': 'Configure heat map',
  'demand_zones.configure_colours': 'Configure zone colours',
  'demand_zones.configure_surge': 'Configure surge multipliers',
  'demand_zones.view_audit': 'View demand zone audit',
};

export const DEMAND_ZONE_ACTION_HELP: Record<DemandZoneRoleActionKey, string> = {
  'demand_zones.view':
    'Read computed and manual demand zones. Required for zone list/map RLS alongside page access.',
  'demand_zones.recompute':
    'Run compute-driver-demand-zones for a service area from the admin panel.',
  'demand_zones.configure_heatmap':
    'Edit heat-map thresholds, interval, radius, hysteresis, and manual-zone toggle.',
  'demand_zones.configure_colours':
    'Edit LOW / MEDIUM / HIGH zone colours shown on admin and driver maps.',
  'demand_zones.configure_surge':
    'Enable zone surge and edit LOW / MEDIUM / HIGH multipliers.',
  'demand_zones.view_audit':
    'Open the Audit tab and read demand_zone_audit_log entries.',
};

/* ------------------------------------------------------------------ */
/* Help copy                                                           */
/* ------------------------------------------------------------------ */

export const HELP_MODAL_TITLE = 'How Roles & Permissions Work';

export const HELP_MODAL_BODY = [
  'Super Admin is the default owner of staff access and permissions.',
  'Only a Super Admin can create roles, assign roles, change permissions, or grant access to service areas.',
  'Other staff members can manage roles and permissions only when a Super Admin explicitly grants them the required permission.',
  'Giving access to this page does not automatically give permission to change staff roles. View, create, edit, assign, and delete permissions are controlled separately.',
  'Changes take effect immediately and are recorded in the Audit Log.',
];

export const HELP_MODAL_WARNING =
  'Important: Granting permission-management access allows the staff member to change access for other users. Assign it only to trusted staff.';

export const TAB_HELP = {
  staff:
    'View staff accounts, assigned roles, account status, and service-area access. Role assignments may only be changed by authorised staff.',
  permissions:
    'Control which pages and actions each role can access. Super Admin access is protected and cannot be removed.',
  audit:
    'Review role, permission, staff-access, and service-area assignment changes. Audit records cannot be edited by staff.',
} as const;

export const ROLE_TOOLTIPS: Record<StaffRoleKey, string> = {
  super_admin: 'Super Admin — protected system owner with full access.',
  admin: 'Admin — administrative access defined by the Super Admin.',
  operator: 'Operator — operational and dispatch access defined by the Super Admin.',
  finance_manager:
    'Finance — finance, payments, wallet, and reporting access defined by the Super Admin.',
  customer_support: 'Customer Support — customer and trip support access defined by the Super Admin.',
  compliance_officer:
    'Compliance — driver documents, identity, and compliance access defined by the Super Admin.',
};

export const ROLE_FULL_NAMES: Record<StaffRoleKey, string> = {
  super_admin: 'Super Admin',
  admin: 'Admin',
  operator: 'Operator',
  finance_manager: 'Finance Manager',
  customer_support: 'Customer Support',
  compliance_officer: 'Compliance Officer',
};

/* ------------------------------------------------------------------ */
/* Per-page help copy (every matrix row)                               */
/* ------------------------------------------------------------------ */

export const PAGE_HELP: Record<string, string> = {
  dashboard: 'Allows the role to open the main Admin Dashboard.',
  'fleet-tracking': 'Allows the role to view driver locations and fleet availability.',
  'active-trips':
    'Allows the role to view live trips. Actions such as reassignment or cancellation require separate permissions.',
  'auto-dispatch': 'Allows the role to access automatic dispatch controls and operational status.',
  'driver-demand-zones':
    'Allows the role to view driver demand zones, heat-map settings, and zone surge configuration.',
  'scheduled-rides':
    'Allows the role to view and manage scheduled bookings according to its granted action permissions.',
  'missed-cancelled': 'Allows the role to review missed and cancelled bookings and their reasons.',
  'trip-history':
    'Allows the role to view historical trip records. Sensitive financial or customer data still requires the relevant separate permissions.',
  'manual-trip': 'Allows the role to create bookings manually on behalf of a customer.',
  'qr-booking': 'Allows the role to configure and monitor guest QR bookings.',
  drivers: 'Allows the role to view driver accounts, status, and onboarding progress.',
  vehicles: 'Allows the role to view and manage vehicles and their approval state.',
  'vehicle-types': 'Allows the role to manage the vehicle categories offered to customers.',
  documents: 'Allows the role to view driver and vehicle documents and their expiry state.',
  'document-management':
    'Allows the role to review, approve, or reject uploaded compliance documents.',
  regions: 'Allows the role to manage regions, currency, and distance-unit settings.',
  services: 'Allows the role to manage service areas, boundaries, and operating rules.',
  'promo-codes': 'Allows the role to create and manage customer promotional codes.',
  'custom-zones': 'Allows the role to manage custom pricing zones and fare modifiers.',
  'zone-pricing': 'Allows the role to configure zone-based fare pricing.',
  'corporate-fares': 'Allows the role to configure corporate fare rules and negotiated pricing.',
  'fare-simulator': 'Allows the role to run fare estimates without changing live pricing.',
  'corporate-accounts': 'Allows the role to view and manage corporate customer accounts.',
  'account-requests': 'Allows the role to review and approve new corporate account requests.',
  'corporate-billing': 'Allows the role to view corporate invoices and billing activity.',
  'corporate-reports': 'Allows the role to view corporate usage and spend reporting.',
  'corporate-settings': 'Allows the role to change corporate account policies and settings.',
  riders: 'Allows the role to view rider accounts and their trip statistics.',
  'pending-customer-signups': 'Allows the role to review rider sign-ups awaiting verification.',
  'rider-feedback': 'Allows the role to read rider ratings and written feedback.',
  suspensions: 'Allows the role to view and manage account suspensions.',
  complaints: 'Allows the role to manage customer and driver complaints.',
  'live-chat': 'Allows the role to answer live support conversations.',
  tickets: 'Allows the role to manage support tickets and their resolution.',
  categories: 'Allows the role to manage support and content categories.',
  'payment-sessions':
    'Allows the role to view payment authorisations and captures. Recovery and capture actions require separate permissions.',
  'financial-reconciliation':
    'Allows the role to view reconciliation between provider settlements and internal ledgers.',
  'driver-wallet-ledger': 'Allows the role to view the driver wallet ledger, the financial source of truth.',
  'commission-wallet': 'Allows the role to view and manage driver commission wallet balances.',
  'payout-ledger': 'Allows the role to view payout batches, transfers, and company funding.',
  disputes: 'Allows the role to manage financial disputes and manual adjustments.',
  'dispute-settings': 'Allows the role to configure dispute categories and handling rules.',
  invoices: 'Allows the role to view and issue invoices.',
  'invoice-templates': 'Allows the role to edit the layout and content of issued invoices.',
  'statement-runs': 'Allows the role to view and trigger driver earnings statement runs.',
  'onecab-documents': 'Allows the role to manage company-level compliance documents.',
  content: 'Allows the role to edit published legal, help, and marketing content.',
  'general-settings': 'Allows the role to change global platform settings.',
  integrations: 'Allows the role to view and configure third-party integrations.',
  webhooks: 'Allows the role to view and configure outbound webhooks.',
  system: 'Allows the role to access system-level diagnostics and maintenance tools.',
  roles:
    'Allows access to staff roles and permissions. Viewing this page does not automatically allow creating, editing, assigning, or deleting roles.',
  'user-directory': 'Allows the role to search the platform user directory.',
  notifications: 'Allows the role to manage notification templates and alert rules.',
  'alert-sounds': 'Allows the role to manage the alert sounds used by the driver and customer apps.',
};

export function pageHelpText(slug: string): string {
  return (
    PAGE_HELP[slug] ??
    `Allows the role to open the ${slug.replace(/-/g, ' ')} page. Actions on that page may require separate permissions.`
  );
}

/* ------------------------------------------------------------------ */
/* Form help copy                                                      */
/* ------------------------------------------------------------------ */

export const STAFF_FORM_HELP = {
  role: 'The assigned role controls page and action access. Only authorised staff can change this assignment.',
  serviceAreas:
    'Limits the staff member to the selected operating areas. Access outside those service areas must be blocked by backend policy.',
  superAdmin:
    'Super Admin has protected full-platform access. Only an existing Super Admin can grant this role.',
} as const;

export const DELEGATION_CONFIRM = {
  title: 'Grant sensitive access?',
  message:
    'This permission allows the role to manage staff access or security settings. Only grant it to trusted staff.',
  cancel: 'Cancel',
  confirm: 'Grant Permission',
} as const;

export const DENIED_COPY = {
  readOnlyBanner:
    'You have read-only access. A Super Admin must grant additional permission before you can change staff roles or permissions.',
  actionDenied: 'You do not have permission to perform this action.',
  protectedSuperAdmin:
    'This Super Admin account is protected and cannot be changed by your role.',
} as const;

/* ------------------------------------------------------------------ */
/* Capability model                                                    */
/* ------------------------------------------------------------------ */

export interface ActorContext {
  /** Resolved staff role, or null for a legacy admin with no staff profile. */
  role: StaffRoleKey | null;
  isSuperAdmin: boolean;
  /** Action keys explicitly allowed for the actor's role. */
  allowedActions: string[];
  /** Page slugs the actor's role can access (used for grant-what-you-have). */
  allowedPages?: string[];
}

/** Super Admin implicitly holds every capability. */
export function actorHasAction(actor: ActorContext, key: RoleActionKey | string): boolean {
  if (actor.isSuperAdmin) return true;
  return actor.allowedActions.includes(key);
}

export function isReadOnlyActor(actor: ActorContext): boolean {
  if (actor.isSuperAdmin) return false;
  return !SENSITIVE_ACTION_KEYS.some((k) => actor.allowedActions.includes(k));
}

export interface GuardResult {
  allowed: boolean;
  reason?: string;
}

const ALLOW: GuardResult = { allowed: true };
const deny = (reason: string): GuardResult => ({ allowed: false, reason });

/** Super Admin permissions can never be unticked. */
export function canTogglePagePermission(
  actor: ActorContext,
  targetRole: StaffRoleKey,
  pageSlug: string,
  nextValue: boolean,
): GuardResult {
  if (targetRole === PROTECTED_ROLE) return deny(DENIED_COPY.protectedSuperAdmin);
  if (!actorHasAction(actor, 'roles_permissions.manage_permissions'))
    return deny(DENIED_COPY.actionDenied);
  if (nextValue && !actor.isSuperAdmin) {
    const pages = actor.allowedPages ?? [];
    if (!pages.includes(pageSlug)) return deny('You cannot grant a permission you do not have.');
  }
  return ALLOW;
}

export function canToggleActionPermission(
  actor: ActorContext,
  targetRole: StaffRoleKey,
  actionKey: string,
  nextValue: boolean,
): GuardResult {
  if (targetRole === PROTECTED_ROLE) return deny(DENIED_COPY.protectedSuperAdmin);
  if (!actorHasAction(actor, 'roles_permissions.manage_permissions'))
    return deny(DENIED_COPY.actionDenied);
  if (nextValue && !actorHasAction(actor, actionKey))
    return deny('You cannot grant a permission you do not have.');
  return ALLOW;
}

export interface TargetStaff {
  role: StaffRoleKey;
  isActive: boolean;
}

export function canAssignRole(
  actor: ActorContext,
  target: TargetStaff,
  newRole: StaffRoleKey,
  activeSuperAdminCount: number,
): GuardResult {
  if (!actorHasAction(actor, 'roles_permissions.assign_role'))
    return deny(DENIED_COPY.actionDenied);
  if ((newRole === PROTECTED_ROLE || target.role === PROTECTED_ROLE) && !actor.isSuperAdmin)
    return deny('Only an existing Super Admin can grant or change the Super Admin role.');
  if (
    target.role === PROTECTED_ROLE &&
    newRole !== PROTECTED_ROLE &&
    target.isActive &&
    activeSuperAdminCount <= 1
  )
    return deny('The last active Super Admin cannot be downgraded.');
  return ALLOW;
}

export function canRemoveStaff(
  actor: ActorContext,
  target: TargetStaff,
  activeSuperAdminCount: number,
): GuardResult {
  if (!actorHasAction(actor, 'roles_permissions.delete_role'))
    return deny(DENIED_COPY.actionDenied);
  if (target.role === PROTECTED_ROLE && !actor.isSuperAdmin)
    return deny(DENIED_COPY.protectedSuperAdmin);
  if (target.role === PROTECTED_ROLE && target.isActive && activeSuperAdminCount <= 1)
    return deny('The last active Super Admin cannot be removed.');
  return ALLOW;
}

export function canSetStaffActive(
  actor: ActorContext,
  target: TargetStaff,
  nextActive: boolean,
  activeSuperAdminCount: number,
): GuardResult {
  if (!actorHasAction(actor, 'roles_permissions.edit_role'))
    return deny(DENIED_COPY.actionDenied);
  if (target.role === PROTECTED_ROLE && !actor.isSuperAdmin)
    return deny(DENIED_COPY.protectedSuperAdmin);
  if (target.role === PROTECTED_ROLE && !nextActive && activeSuperAdminCount <= 1)
    return deny('The last active Super Admin cannot be disabled.');
  return ALLOW;
}

export function canEditStaff(actor: ActorContext, target: TargetStaff): GuardResult {
  if (!actorHasAction(actor, 'roles_permissions.edit_role'))
    return deny(DENIED_COPY.actionDenied);
  if (target.role === PROTECTED_ROLE && !actor.isSuperAdmin)
    return deny(DENIED_COPY.protectedSuperAdmin);
  return ALLOW;
}

export function canCreateStaff(
  actor: ActorContext,
  newRole: StaffRoleKey,
  serviceAreaCount = 0,
): GuardResult {
  if (!actorHasAction(actor, 'roles_permissions.create_role'))
    return deny(DENIED_COPY.actionDenied);
  if (newRole === PROTECTED_ROLE && !actor.isSuperAdmin)
    return deny('Only an existing Super Admin can grant the Super Admin role.');
  if (serviceAreaCount > 0 && !actorHasAction(actor, 'roles_permissions.assign_service_areas'))
    return deny('You do not have permission to assign service areas.');
  return ALLOW;
}
