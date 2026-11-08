/**
 * ONECAB Admin — navigable page catalog (SSOT)
 *
 * Used by:
 *  - Permissions Matrix (Roles & Permissions)
 *  - Sidebar visibility
 *  - Route / AdminPageAccessGate checks
 *
 * Rules:
 *  - One matrix tick grants exactly one page_slug (no alias expansion).
 *  - Legacy redirect paths normalize to a canonical slug before the check —
 *    that is path resolution, not permission expansion.
 *  - Pages absent from this catalog are denied to non-owners.
 *  - `roles` is Owner-only at the access layer (matrix row is informational).
 *  - `profile` requires an explicit matrix grant (not an open exception).
 */

export type AdminPageGroupId =
  | 'dashboard'
  | 'operations'
  | 'fleet'
  | 'service_areas'
  | 'pricing'
  | 'corporate'
  | 'riders'
  | 'support'
  | 'finance'
  | 'statements'
  | 'reports'
  | 'documents'
  | 'content'
  | 'settings'
  | 'account';

export interface AdminPageDefinition {
  slug: string;
  label: string;
  group: AdminPageGroupId;
  /** Shown in Permissions Matrix (default true). */
  matrix?: boolean;
  /**
   * Shown in the primary sidebar when the role has the grant.
   * Orphan / deep-link pages may be matrix-only (false).
   */
  sidebar?: boolean;
  /** Owner-only; non-owners are always denied even if granted in DB. */
  ownerOnly?: boolean;
  help?: string;
}

export interface AdminPageGroup {
  id: AdminPageGroupId;
  label: string;
}

/**
 * Legacy / alternate path segments → canonical permission slug.
 * Used only by the route gate so old bookmarks still hit the same page check.
 * Does NOT make one matrix tick unlock multiple distinct pages.
 */
export const ADMIN_PATH_TO_PAGE_SLUG: Readonly<Record<string, string>> = {
  payments: 'payment-sessions',
  'driver-wallet': 'driver-wallet-ledger',
  'admin-settlements': 'financial-reconciliation',
  'finance-ledger-transactions': 'driver-wallet-ledger',
  'payout-batches': 'payout-ledger',
  'connect-payout-lockdown': 'payout-ledger',
  'drivers-and-payouts': 'financial-reconciliation',
};

export const ADMIN_PAGE_GROUPS: readonly AdminPageGroup[] = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'operations', label: 'Operations' },
  { id: 'fleet', label: 'Fleet' },
  { id: 'service_areas', label: 'Service Areas' },
  { id: 'pricing', label: 'Pricing' },
  { id: 'corporate', label: 'Corporate' },
  { id: 'riders', label: 'Riders' },
  { id: 'support', label: 'Support' },
  { id: 'finance', label: 'Finance' },
  { id: 'statements', label: 'Driver Statements' },
  { id: 'reports', label: 'Reports' },
  { id: 'documents', label: 'Documents' },
  { id: 'content', label: 'Content & Legal' },
  { id: 'settings', label: 'Settings' },
  { id: 'account', label: 'Account' },
] as const;

/**
 * Every navigable admin page. Keep in sync with App.tsx protected routes.
 * Orphan routes (reachable by URL but not primary sidebar) still appear in the matrix.
 */
export const ADMIN_PAGE_CATALOG: readonly AdminPageDefinition[] = [
  {
    slug: 'dashboard',
    label: 'Main Dashboard',
    group: 'dashboard',
    help: 'Allows the role to open the main Admin Dashboard.',
  },

  // Operations
  { slug: 'fleet-tracking', label: 'Live Fleet Tracking', group: 'operations', help: 'Allows the role to view driver locations and fleet availability.' },
  { slug: 'active-trips', label: 'Active Trips', group: 'operations', help: 'Allows the role to view live trips. Actions such as reassignment or cancellation require separate permissions.' },
  { slug: 'auto-dispatch', label: 'Auto-Dispatch Rules', group: 'operations', help: 'Allows the role to access automatic dispatch controls and operational status.' },
  { slug: 'scheduled-rides', label: 'Scheduled Rides', group: 'operations', help: 'Allows the role to view and manage scheduled bookings according to its granted action permissions.' },
  { slug: 'missed-cancelled', label: 'Missed & Cancelled', group: 'operations', help: 'Allows the role to review missed and cancelled bookings and their reasons.' },
  { slug: 'trip-history', label: 'Trip History', group: 'operations', help: 'Allows the role to view historical trip records. Sensitive financial or customer data still requires the relevant separate permissions.' },
  { slug: 'manual-trip', label: 'Manual Trip Creation', group: 'operations', help: 'Allows the role to create bookings manually on behalf of a customer.' },
  { slug: 'dispatch', label: 'Dispatch Console', group: 'operations', sidebar: true, help: 'Allows the role to open the dispatch console.' },
  { slug: 'dispatch-metrics', label: 'Dispatch Metrics', group: 'operations', help: 'Allows the role to view dispatch performance metrics.' },
  { slug: 'driver-demand-zones', label: 'Driver Demand Zones', group: 'operations', help: 'Allows the role to view driver demand zones, heat-map settings, and zone surge configuration.' },
  { slug: 'staff-work-patterns', label: 'Staff Work Patterns', group: 'operations', help: 'Allows the role to view staff work-pattern analytics.' },
  { slug: 'qr-booking', label: 'QR Booking', group: 'operations', sidebar: false, help: 'Allows the role to configure and monitor guest QR bookings.' },

  // Fleet
  { slug: 'drivers', label: 'Driver List', group: 'fleet', help: 'Allows the role to view driver accounts, status, and onboarding progress.' },
  { slug: 'vehicles', label: 'Vehicle List', group: 'fleet', help: 'Allows the role to view and manage vehicles and their approval state.' },
  { slug: 'vehicle-types', label: 'Vehicle Types', group: 'fleet', help: 'Allows the role to manage the vehicle categories offered to customers.' },
  { slug: 'documents', label: 'Document Review', group: 'fleet', help: 'Allows the role to view driver and vehicle documents and their expiry state.' },
  { slug: 'document-management', label: 'Document Management', group: 'fleet', help: 'Allows the role to review, approve, or reject uploaded compliance documents.' },

  // Service areas
  { slug: 'regions', label: 'Regions', group: 'service_areas', help: 'Allows the role to manage regions, currency, and distance-unit settings.' },
  { slug: 'services', label: 'Services', group: 'service_areas', help: 'Allows the role to manage service areas, boundaries, and operating rules.' },
  { slug: 'service-area-pricing', label: 'Service Area Pricing', group: 'service_areas', sidebar: true, help: 'Allows the role to manage per-service-area pricing configuration.' },

  // Pricing
  { slug: 'promo-codes', label: 'Promo Codes', group: 'pricing', help: 'Allows the role to create and manage customer promotional codes.' },
  { slug: 'offers', label: 'Customer Offers', group: 'pricing', help: 'Allows the role to manage customer offers.' },
  { slug: 'custom-zones', label: 'Custom Zones', group: 'pricing', help: 'Allows the role to manage custom pricing zones and fare modifiers.' },
  { slug: 'zone-pricing', label: 'Geofence & Zone Pricing', group: 'pricing', help: 'Allows the role to configure zone-based fare pricing.' },
  { slug: 'fare-simulator', label: 'Fare Simulator', group: 'pricing', help: 'Allows the role to run fare estimates without changing live pricing.' },

  // Corporate
  { slug: 'corporate-accounts', label: 'Corporate Accounts', group: 'corporate', help: 'Allows the role to view and manage corporate customer accounts.' },
  { slug: 'account-requests', label: 'Account Requests', group: 'corporate', help: 'Allows the role to review and approve new corporate account requests.' },
  { slug: 'corporate-billing', label: 'Corporate Billing', group: 'corporate', help: 'Allows the role to view corporate invoices and billing activity.' },
  { slug: 'corporate-reports', label: 'Corporate Reports', group: 'corporate', help: 'Allows the role to view corporate usage and spend reporting.' },
  { slug: 'corporate-fares', label: 'Corporate Fare Rules', group: 'corporate', help: 'Allows the role to configure corporate fare rules and negotiated pricing.' },
  { slug: 'corporate-settings', label: 'Corporate Settings', group: 'corporate', help: 'Allows the role to change corporate account policies and settings.' },

  // Riders
  { slug: 'riders', label: 'Rider List', group: 'riders', help: 'Allows the role to view rider accounts and their trip statistics.' },
  { slug: 'pending-customer-signups', label: 'Pending Signups', group: 'riders', help: 'Allows the role to review rider sign-ups awaiting verification.' },
  { slug: 'rider-feedback', label: 'Rider Feedback', group: 'riders', help: 'Allows the role to read rider ratings and written feedback.' },

  // Support
  { slug: 'suspensions', label: 'Account Suspension', group: 'support', help: 'Allows the role to view and manage account suspensions.' },
  { slug: 'complaints', label: 'Complaints Dashboard', group: 'support', help: 'Allows the role to manage customer and driver complaints.' },
  { slug: 'live-chat', label: 'Live Chat', group: 'support', help: 'Allows the role to answer live support conversations.' },
  { slug: 'tickets', label: 'Tickets', group: 'support', help: 'Allows the role to manage support tickets and their resolution.' },
  { slug: 'lost-property', label: 'Lost Property', group: 'support', help: 'Allows the role to manage lost-property cases.' },
  { slug: 'categories', label: 'Support Categories', group: 'support', help: 'Allows the role to manage support and content categories.' },

  // Finance — each page is its own matrix tick
  { slug: 'payment-sessions', label: 'Payment Sessions', group: 'finance', help: 'Allows the role to view payment authorisations and captures. Recovery and capture actions require separate permissions.' },
  {
    slug: 'customer-receivables',
    label: 'Customer Receivables',
    group: 'finance',
    help: 'Allows the role to view and manage customer receivables. Separate from Financial Reconciliation.',
  },
  { slug: 'financial-reconciliation', label: 'Financial Reconciliation', group: 'finance', help: 'Allows the role to view reconciliation between provider settlements and internal ledgers.' },
  { slug: 'driver-wallet-ledger', label: 'Driver Wallet Ledger', group: 'finance', help: 'Allows the role to view the driver wallet ledger, the financial source of truth.' },
  { slug: 'commission-wallet', label: 'Commission Wallet', group: 'finance', help: 'Allows the role to view and manage driver commission wallet balances.' },
  { slug: 'payout-ledger', label: 'Payout Ledger', group: 'finance', help: 'Allows the role to view payout batches, transfers, and company funding.' },
  { slug: 'disputes', label: 'Disputes', group: 'finance', sidebar: false, help: 'Allows the role to manage financial disputes and manual adjustments.' },
  { slug: 'dispute-settings', label: 'Dispute Settings', group: 'finance', sidebar: false, help: 'Allows the role to configure dispute categories and handling rules.' },
  { slug: 'payments-trip-shortfall-recapture', label: 'Trip Shortfall Recapture', group: 'finance', sidebar: false, help: 'Allows the role to manage trip shortfall recapture workflows.' },

  // Statements
  { slug: 'invoices', label: 'Driver Invoices', group: 'statements', help: 'Allows the role to view and issue invoices.' },
  { slug: 'invoice-templates', label: 'Invoice Templates', group: 'statements', help: 'Allows the role to edit the layout and content of issued invoices.' },
  { slug: 'statement-runs', label: 'Statement Schedule', group: 'statements', help: 'Allows the role to view and trigger driver earnings statement runs.' },
  { slug: 'annual-taxi-report', label: 'Annual Driver Statement', group: 'statements', help: 'Allows the role to generate annual driver taxi statements.' },

  // Reports
  { slug: 'onecab-revenue-profit', label: 'ONECAB Revenue & Profit', group: 'reports', help: 'Allows the role to view ONECAB revenue and profit reporting.' },

  // Documents
  { slug: 'onecab-documents', label: 'Compliance Center', group: 'documents', help: 'Allows the role to manage company-level compliance documents.' },

  // Content
  { slug: 'content', label: 'Manage Content', group: 'content', help: 'Allows the role to edit published legal, help, and marketing content.' },
  { slug: 'help-centre', label: 'Help Centre', group: 'content', help: 'Allows the role to manage Help Centre articles.' },
  { slug: 'customer-special-offers', label: 'Customer Special Offers', group: 'content', help: 'Allows the role to manage customer special offers.' },
  { slug: 'driver-special-offers', label: 'Driver Special Offers', group: 'content', help: 'Allows the role to manage driver special offers.' },

  // Settings
  { slug: 'general-settings', label: 'General & Branding', group: 'settings', help: 'Allows the role to change global platform settings.' },
  { slug: 'integrations', label: 'Integrations', group: 'settings', sidebar: false, help: 'Allows the role to view and configure third-party integrations.' },
  { slug: 'payment-providers', label: 'Payment Providers', group: 'settings', help: 'Allows the role to manage payment provider configuration.' },
  { slug: 'webhooks', label: 'Webhooks', group: 'settings', sidebar: false, help: 'Allows the role to view and configure outbound webhooks.' },
  { slug: 'system', label: 'System', group: 'settings', sidebar: false, help: 'Allows the role to access system-level diagnostics and maintenance tools.' },
  {
    slug: 'roles',
    label: 'Roles & Permissions',
    group: 'settings',
    ownerOnly: true,
    help: 'Owner-only. Non-owners cannot open this page even if a matrix row exists.',
  },
  { slug: 'user-directory', label: 'User Directory', group: 'settings', help: 'Allows the role to search the platform user directory.' },
  { slug: 'notifications', label: 'Notifications & Alerts', group: 'settings', help: 'Allows the role to manage notification templates and alert rules.' },
  { slug: 'alert-sounds', label: 'Alert Sounds', group: 'settings', help: 'Allows the role to manage the alert sounds used by the driver and customer apps.' },

  // Account — requires explicit matrix assignment (not an open exception)
  {
    slug: 'profile',
    label: 'My Profile',
    group: 'account',
    sidebar: false,
    help: 'Allows the role to open the signed-in staff profile page. Requires an explicit matrix grant.',
  },
] as const;

const PAGE_BY_SLUG: ReadonlyMap<string, AdminPageDefinition> = new Map(
  ADMIN_PAGE_CATALOG.map((page) => [page.slug, page]),
);

export function isCatalogPageSlug(slug: string): boolean {
  return PAGE_BY_SLUG.has(slug);
}

export function getAdminPage(slug: string): AdminPageDefinition | undefined {
  return PAGE_BY_SLUG.get(slug);
}

/** First path segment → permission slug (applies legacy redirect normalization). */
export function resolvePermissionSlugFromPath(pathname: string): string {
  const raw = pathname.replace(/^\//, '') || 'dashboard';
  const segment = raw.split('/')[0] || 'dashboard';
  return ADMIN_PATH_TO_PAGE_SLUG[segment] ?? segment;
}

/** Matrix groups: label + page slugs in catalog order. */
export function getPermissionMatrixPageGroups(): { label: string; pages: string[] }[] {
  return ADMIN_PAGE_GROUPS.map((group) => ({
    label: group.label,
    pages: ADMIN_PAGE_CATALOG.filter(
      (page) => page.group === group.id && page.matrix !== false,
    ).map((page) => page.slug),
  })).filter((group) => group.pages.length > 0);
}

export function pageCatalogHelpText(slug: string): string {
  const page = PAGE_BY_SLUG.get(slug);
  if (page?.help) return page.help;
  return `Allows the role to open the ${slug.replace(/-/g, ' ')} page. Actions on that page may require separate permissions.`;
}
