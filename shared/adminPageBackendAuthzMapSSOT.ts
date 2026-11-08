/**
 * Admin backend authz map (SSOT) — table / Edge / RPC → canonical page slug(s).
 *
 * Branch: fix/assigned-page-rbac (local only; migrations unapplied).
 *
 * Status legend:
 *  - clear              — single-page (or Owner-only catalog); hardened in migration
 *  - shared_fail_closed — table cannot be page-gated without cross-page exposure;
 *                         admin-role policies removed; non-Owner direct access denied
 *                         until page-specific RPC/view is wired in the Admin UI
 *  - page_rpc           — SECURITY DEFINER RPC with exact page check (use instead of table)
 *  - already_gated      — page check already present
 *  - decision_needed    — still open for product review (must NOT be treated as hardened)
 */

export type BackendAuthzOp = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'ALL';

export type MappingStatus =
  | 'clear'
  | 'shared_fail_closed'
  | 'page_rpc'
  | 'already_gated'
  | 'decision_needed';

export interface TableOpPageMap {
  table: string;
  op: BackendAuthzOp;
  /** Pages that legitimately need this op. Empty when fail-closed / Owner-only. */
  pages: readonly string[];
  status: MappingStatus;
  notes: string;
  /** Proposed or shipped RPC/view when table-level gating is unsafe. */
  pageRpc?: string;
}

export interface EdgeRpcPageMapping {
  name: string;
  kind: 'edge' | 'rpc' | 'view';
  pages: readonly string[];
  status: MappingStatus;
  notes: string;
}

/* ------------------------------------------------------------------ */
/* Clear single-page tables (restrictive: 20261231140000)              */
/* ------------------------------------------------------------------ */

export const CLEAR_TABLE_PAGE_MAP: readonly TableOpPageMap[] = [
  { table: 'offers', op: 'SELECT', pages: ['offers'], status: 'clear', notes: 'Offers page list/detail.' },
  { table: 'offers', op: 'ALL', pages: ['offers'], status: 'clear', notes: 'Offers write.' },
  { table: 'offer_service_areas', op: 'ALL', pages: ['offers'], status: 'clear', notes: 'Tied to offers.' },
  { table: 'offer_redemptions', op: 'SELECT', pages: ['offers'], status: 'clear', notes: 'Admin leg; customer own-row retained.' },
  { table: 'complaints', op: 'SELECT', pages: ['complaints'], status: 'clear', notes: 'Complaints dashboard.' },
  { table: 'complaints', op: 'INSERT', pages: ['complaints'], status: 'clear', notes: '' },
  { table: 'complaints', op: 'UPDATE', pages: ['complaints'], status: 'clear', notes: '' },
  { table: 'complaints', op: 'DELETE', pages: ['complaints'], status: 'clear', notes: '' },
  { table: 'promo_codes', op: 'ALL', pages: ['promo-codes'], status: 'clear', notes: '' },
  { table: 'rider_feedback', op: 'SELECT', pages: ['rider-feedback'], status: 'clear', notes: '' },
  { table: 'rider_feedback', op: 'UPDATE', pages: ['rider-feedback'], status: 'clear', notes: '' },
  { table: 'rider_feedback', op: 'DELETE', pages: ['rider-feedback'], status: 'clear', notes: '' },
  { table: 'account_suspensions', op: 'ALL', pages: ['suspensions'], status: 'clear', notes: '' },
  { table: 'lost_property_cases', op: 'ALL', pages: ['lost-property'], status: 'clear', notes: '' },
  { table: 'invoice_templates', op: 'ALL', pages: ['invoice-templates'], status: 'clear', notes: '' },
  { table: 'statement_runs', op: 'ALL', pages: ['statement-runs'], status: 'clear', notes: '' },
  { table: 'invoices', op: 'ALL', pages: ['invoices'], status: 'clear', notes: '' },
  { table: 'corporate_accounts', op: 'ALL', pages: ['corporate-accounts'], status: 'clear', notes: '' },
  { table: 'corporate_account_requests', op: 'SELECT', pages: ['account-requests'], status: 'clear', notes: '' },
  { table: 'regions', op: 'INSERT', pages: ['regions'], status: 'clear', notes: '' },
  { table: 'regions', op: 'UPDATE', pages: ['regions'], status: 'clear', notes: '' },
  { table: 'regions', op: 'DELETE', pages: ['regions'], status: 'clear', notes: '' },
  { table: 'service_areas', op: 'INSERT', pages: ['services'], status: 'clear', notes: '' },
  { table: 'service_areas', op: 'UPDATE', pages: ['services'], status: 'clear', notes: '' },
  { table: 'service_areas', op: 'DELETE', pages: ['services'], status: 'clear', notes: '' },
  { table: 'vehicle_types', op: 'INSERT', pages: ['vehicle-types'], status: 'clear', notes: 'Public read policy retained.' },
  { table: 'vehicle_types', op: 'UPDATE', pages: ['vehicle-types'], status: 'clear', notes: '' },
  { table: 'vehicle_types', op: 'DELETE', pages: ['vehicle-types'], status: 'clear', notes: '' },
  {
    table: 'vehicles',
    op: 'SELECT',
    pages: ['vehicles', 'drivers'],
    status: 'clear',
    notes:
      'RESOLVED: admin SELECT via staff_has_any_page_access(vehicles|drivers). Drivers list hydrates vehicles by driver_id; Vehicles page retains primary grant. Writes stay Vehicles/driver-owned.',
  },
  { table: 'payout_batches', op: 'SELECT', pages: ['payout-ledger'], status: 'clear', notes: '' },
  { table: 'payout_batches', op: 'INSERT', pages: ['payout-ledger'], status: 'clear', notes: '' },
  { table: 'payout_batches', op: 'UPDATE', pages: ['payout-ledger'], status: 'clear', notes: '' },
  { table: 'payout_items', op: 'SELECT', pages: ['payout-ledger'], status: 'clear', notes: '' },
  { table: 'payout_items', op: 'INSERT', pages: ['payout-ledger'], status: 'clear', notes: '' },
  { table: 'payout_items', op: 'UPDATE', pages: ['payout-ledger'], status: 'clear', notes: '' },
  { table: 'notifications', op: 'ALL', pages: ['notifications'], status: 'clear', notes: 'Admin manage policy; user-targeted SELECT retained.' },
  { table: 'driver_wallet_ledger', op: 'SELECT', pages: ['driver-wallet-ledger'], status: 'clear', notes: 'Replaces finance role-enum; Owner via helper.' },
] as const;

/* ------------------------------------------------------------------ */
/* Shared tables — traced page usage + fail-closed decision            */
/* ------------------------------------------------------------------ */

/**
 * Why fail-closed (not a page OR-list):
 * Granting table SELECT to the union of pages that touch the table lets any one
 * of those pages open full-table reads for the others (e.g. dashboard → all trips).
 * Column/row scoping requires page-specific RPCs or views.
 */
export const SHARED_TABLE_OP_MAP: readonly TableOpPageMap[] = [
  // ---- trips ----
  {
    table: 'trips',
    op: 'SELECT',
    pages: [
      'dashboard',
      'active-trips',
      'trip-history',
      'missed-cancelled',
      'scheduled-rides',
      'manual-trip',
      'fleet-tracking',
      'dispatch',
      'corporate-billing',
      'corporate-reports',
      'rider-feedback',
      'lost-property',
      'payment-sessions',
      'financial-reconciliation',
    ],
    status: 'page_rpc',
    notes:
      'Use admin_page_select(page, trips, args). Admin UI cutover complete for listed pages (no direct JWT .from(trips) in src/).',
    pageRpc: 'admin_page_select',
  },
  {
    table: 'trips',
    op: 'INSERT',
    pages: ['manual-trip'],
    status: 'page_rpc',
    notes: 'ManualTrip → admin_page_mutate(manual-trip, trips, insert) only. No scheduled-rides insert grant.',
    pageRpc: 'admin_page_mutate',
  },
  {
    table: 'trips',
    op: 'UPDATE',
    pages: ['scheduled-rides', 'manual-trip', 'active-trips', 'missed-cancelled'],
    status: 'page_rpc',
    notes:
      'ScheduledRides / ManualTrip / ActiveTrips / MissedCancelled → admin_page_mutate(…, trips, update). Prefer admin-trip-action Edge where already gated.',
    pageRpc: 'admin_page_mutate; admin-trip-action Edge',
  },
  {
    table: 'trips',
    op: 'DELETE',
    pages: [],
    status: 'shared_fail_closed',
    notes: 'No admin page should hard-delete trips via client. Owner-only / deny.',
  },

  // ---- drivers ----
  {
    table: 'drivers',
    op: 'SELECT',
    pages: [
      'drivers',
      'fleet-tracking',
      'active-trips',
      'scheduled-rides',
      'manual-trip',
      'dashboard',
      'documents',
      'services',
      'regions',
      'invoices',
      'statement-runs',
      'annual-taxi-report',
      'disputes',
      'rider-feedback',
      'lost-property',
      'payout-ledger',
      'driver-wallet-ledger',
      'live-chat',
    ],
    status: 'page_rpc',
    notes:
      'Use admin_page_select(page, drivers, args). Admin UI cutover complete (no direct JWT .from(drivers) in src/).',
    pageRpc: 'admin_page_select',
  },
  {
    table: 'drivers',
    op: 'UPDATE',
    pages: ['drivers', 'services'],
    status: 'page_rpc',
    notes:
      'Drivers.tsx + DriverDetailsDialog → admin_page_mutate(drivers, …). Services assigned-driver clear → admin_page_mutate(services, drivers, update).',
    pageRpc: 'admin_page_mutate',
  },
  {
    table: 'drivers',
    op: 'DELETE',
    pages: ['drivers'],
    status: 'shared_fail_closed',
    notes: 'Rare; Owner-only / drivers RPC.',
  },
  {
    table: 'drivers',
    op: 'INSERT',
    pages: ['drivers'],
    status: 'shared_fail_closed',
    notes: 'Admin insert policy existed without has_role in qual — fail-closed.',
  },

  // ---- customers ----
  {
    table: 'customers',
    op: 'SELECT',
    pages: [
      'riders',
      'pending-customer-signups',
      'suspensions',
      'live-chat',
      'tickets',
      'manual-trip',
      'rider-feedback',
      'lost-property',
      'dashboard',
      'customer-receivables',
    ],
    status: 'page_rpc',
    notes:
      'Riders → admin_list_riders_page. Lookups → admin_page_select / adminLookupByIds. Admin UI cutover complete (no direct JWT .from(customers) in src/).',
    pageRpc: 'admin_list_riders_page; admin_page_select',
  },
  {
    table: 'customers',
    op: 'ALL',
    pages: ['riders', 'pending-customer-signups', 'suspensions'],
    status: 'page_rpc',
    notes: 'RiderDetailsDialog delete path → admin_page_mutate(riders, customers, update). Other ops pages still need audit.',
    pageRpc: 'admin_page_mutate',
  },

  // ---- documents ----
  {
    table: 'documents',
    op: 'ALL',
    pages: ['documents', 'document-management', 'drivers'],
    status: 'page_rpc',
    notes:
      'Documents.tsx list/review/purge + DriverDetailsDialog compliance + sidebar counts via admin_page_select/mutate + admin_sidebar_badge_counts.',
    pageRpc: 'admin_page_select; admin_page_mutate',
  },

  // ---- payment_sessions ----
  {
    table: 'payment_sessions',
    op: 'ALL',
    pages: ['payment-sessions'],
    status: 'shared_fail_closed',
    notes:
      'Live RLS: service_role ALL only (no authenticated admin policy). Client PaymentControlsCard reads via user JWT → already denied by RLS. Access must be Edge/RPC with payment-sessions page. No admin-role policy to replace; keep deny for authenticated.',
    pageRpc: 'Existing payment Edges (gated); optional admin_get_payment_session RPC [proposed]',
  },
] as const;

/** Catalog / staff identity (Owner or own role). */
export const CATALOG_TABLE_MAP: readonly TableOpPageMap[] = [
  {
    table: 'role_page_permissions',
    op: 'SELECT',
    pages: [],
    status: 'clear',
    notes: 'Own role_id OR active Owner only.',
  },
  {
    table: 'role_action_permissions',
    op: 'SELECT',
    pages: [],
    status: 'clear',
    notes: 'Own role_id OR active Owner only.',
  },
  {
    table: 'staff_roles_catalog',
    op: 'SELECT',
    pages: [],
    status: 'clear',
    notes: 'Own role OR active Owner only.',
  },
  {
    table: 'staff_profiles',
    op: 'SELECT',
    pages: [],
    status: 'clear',
    notes: 'Self OR active Owner only.',
  },
] as const;

/* ------------------------------------------------------------------ */
/* Edge / RPC map                                                      */
/* ------------------------------------------------------------------ */

export const EDGE_RPC_PAGE_MAP: readonly EdgeRpcPageMapping[] = [
  // Already gated / wave 1
  { name: 'admin-customer-receivables', kind: 'edge', pages: ['customer-receivables'], status: 'clear', notes: 'Canonical slug (was FR).' },
  { name: 'admin-payout-ledger', kind: 'edge', pages: ['payout-ledger'], status: 'already_gated', notes: '' },
  { name: 'admin-commission-wallet-*', kind: 'edge', pages: ['commission-wallet'], status: 'already_gated', notes: '' },
  { name: 'admin-driver-financial-repair', kind: 'edge', pages: ['driver-wallet-ledger'], status: 'already_gated', notes: '' },
  { name: 'whatsapp-resolve / whatsapp-reply', kind: 'edge', pages: ['live-chat'], status: 'already_gated', notes: '' },
  { name: 'lost-property admin actions', kind: 'edge', pages: ['lost-property'], status: 'already_gated', notes: '' },
  { name: 'admin-capture/cancel/refund-trip-payment', kind: 'edge', pages: ['payment-sessions'], status: 'clear', notes: 'Wave 1.' },
  { name: 'admin-get-trip-payment-state', kind: 'edge', pages: ['payment-sessions'], status: 'clear', notes: 'Wave 1.' },
  { name: 'revolut-capture/cancel/refund-order', kind: 'edge', pages: ['payment-sessions'], status: 'clear', notes: 'Wave 1.' },
  { name: 'admin-payment-providers', kind: 'edge', pages: ['payment-providers'], status: 'clear', notes: 'Wave 1.' },
  { name: 'trip-invoice-process', kind: 'edge', pages: ['invoices'], status: 'clear', notes: 'Wave 1.' },
  { name: 'admin-driver-invoice', kind: 'edge', pages: ['invoices', 'invoice-templates', 'annual-taxi-report'], status: 'already_gated', notes: 'requireAnyPageAccess.' },
  { name: 'corporate / lost-property / user-directory RPCs', kind: 'rpc', pages: ['account-requests', 'corporate-accounts', 'lost-property', 'user-directory'], status: 'already_gated', notes: 'staff_has_page_access in body.' },
  { name: 'admin_set_role_* / admin_*_staff*', kind: 'rpc', pages: ['roles'], status: 'already_gated', notes: 'Owner-only via staff_has_action(roles_permissions.*).' },

  // Wave 2 — newly gated Edges
  {
    name: 'admin-trip-action',
    kind: 'edge',
    pages: ['active-trips', 'manual-trip', 'scheduled-rides'],
    status: 'clear',
    notes: 'force_complete/reassign/notify — any of these ops pages.',
  },
  {
    name: 'admin-get-trips-capture-ssot',
    kind: 'edge',
    pages: ['payment-sessions', 'financial-reconciliation', 'trip-history'],
    status: 'clear',
    notes: 'Capture SSOT enrichment for finance/history UIs.',
  },
  {
    name: 'admin-add-trip-finance-note',
    kind: 'edge',
    pages: ['financial-reconciliation', 'payment-sessions', 'trip-history'],
    status: 'clear',
    notes: 'Finance note on trip.',
  },
  { name: 'admin-hold-action', kind: 'edge', pages: ['payment-sessions'], status: 'clear', notes: 'Hold release/retry.' },
  { name: 'admin-request-extra-payment', kind: 'edge', pages: ['payment-sessions'], status: 'clear', notes: 'Extra payment order.' },
  {
    name: 'admin-continuous-reconciliation',
    kind: 'edge',
    pages: ['financial-reconciliation'],
    status: 'clear',
    notes: '',
  },
  {
    name: 'admin-payment-holds-reconciliation',
    kind: 'edge',
    pages: ['payment-sessions', 'financial-reconciliation'],
    status: 'clear',
    notes: '',
  },
  {
    name: 'admin-revolut-orphan-reconciliation',
    kind: 'edge',
    pages: ['financial-reconciliation'],
    status: 'clear',
    notes: '',
  },
  {
    name: 'admin-recover-revolut-orphan',
    kind: 'edge',
    pages: ['financial-reconciliation'],
    status: 'clear',
    notes: '',
  },
  {
    name: 'admin-payment-lifecycle-audit',
    kind: 'edge',
    pages: ['payment-sessions', 'financial-reconciliation'],
    status: 'clear',
    notes: '',
  },
  {
    name: 'admin-service-area-digital-payment-methods',
    kind: 'edge',
    pages: ['services'],
    status: 'clear',
    notes: 'Configured from Services / area payment settings.',
  },
  {
    name: 'admin-revolut-business-oauth',
    kind: 'edge',
    pages: ['payment-providers'],
    status: 'clear',
    notes: 'Provider OAuth; Owner still bypasses via page helper.',
  },
  {
    name: 'admin-lovable-publish',
    kind: 'edge',
    pages: ['system'],
    status: 'clear',
    notes: 'System tools; non-Owner needs system grant.',
  },
  {
    name: 'lovable-app-publish',
    kind: 'edge',
    pages: ['system'],
    status: 'clear',
    notes: '',
  },
  { name: 'ops-ai-summary', kind: 'edge', pages: ['system'], status: 'clear', notes: '' },
  { name: 'ops-seed', kind: 'edge', pages: ['system'], status: 'clear', notes: 'Destructive; page + prefer Owner operationally.' },
  { name: 'query-performance', kind: 'edge', pages: ['system'], status: 'clear', notes: '' },
  { name: 'send-campaign-heads-up', kind: 'edge', pages: ['notifications'], status: 'clear', notes: '' },

  // Additive page RPCs (20261231130000)
  {
    name: 'admin_page_select',
    kind: 'rpc',
    pages: ['*'],
    status: 'page_rpc',
    notes: 'Generic page+table allowlisted SELECT for trips|drivers|customers|documents|vehicles.',
  },
  {
    name: 'admin_page_mutate',
    kind: 'rpc',
    pages: ['drivers', 'riders', 'documents', 'vehicles', 'manual-trip', 'scheduled-rides', 'active-trips', 'missed-cancelled', 'services'],
    status: 'page_rpc',
    notes: 'Page-gated update/insert/delete. trips insert=manual-trip; trips update=scheduled-rides|manual-trip|active-trips|missed-cancelled; drivers update also services.',
  },
  {
    name: 'admin_list_riders_page',
    kind: 'rpc',
    pages: ['riders'],
    status: 'page_rpc',
    notes: 'SECURITY DEFINER riders list + counts. UI uses this (not invoker view).',
  },
  {
    name: 'admin_list_riders_with_trip_stats',
    kind: 'rpc',
    pages: ['riders'],
    status: 'page_rpc',
    notes: 'Compat wrapper → admin_list_riders_page.',
  },
  {
    name: 'admin_dashboard_period_stats / admin_dashboard_chart_rows',
    kind: 'rpc',
    pages: ['dashboard'],
    status: 'page_rpc',
    notes: 'Dashboard KPI + chart.',
  },
  {
    name: 'admin_sidebar_badge_counts',
    kind: 'rpc',
    pages: ['*'],
    status: 'page_rpc',
    notes: 'Each badge requires matching page grant; zeros otherwise.',
  },
  {
    name: 'admin_riders_with_trip_stats (view)',
    kind: 'view',
    pages: ['riders'],
    status: 'clear',
    notes: 'Row gate → staff_has_page_access(riders). Prefer admin_list_riders_page for non-Owner after fail-closed.',
  },
  {
    name: 'find_or_create_customer',
    kind: 'rpc',
    pages: ['manual-trip'],
    status: 'already_gated',
    notes:
      'RESOLVED: self OR staff_has_page_access(manual-trip) OR service_role. Sole Admin UI caller: ManualTrip.tsx.',
  },
] as const;

/**
 * Safe phased rollout (migrations remain LOCAL / UNAPPLIED).
 *
 * CORRECTED order (restrictive RLS must NOT precede UI cutover):
 *
 * Phase 0 — client route/sidebar RBAC (on branch; can ship with or before Phase A).
 * Phase A — apply 20261231130000 (helpers + page RPCs ONLY). Additive; old admin-role
 *           table RLS stays intact so production UI keeps working.
 * Phase B — deploy Admin UI that calls admin_page_* / dashboard+sidebar RPCs, and deploy
 *           Edge requirePageAccess hardenings. Edge page gates are app-level (staff_profiles +
 *           role_page_permissions reads) and do not require the SQL RPCs, but must not be
 *           paired with catalog RLS tightening until this UI is live. Confirm cutover.
 * Phase C — apply 20261231140000 (clear-table + catalog page RLS). Breaks old UI that relied
 *           on admin-role policies for offers/complaints/…/vehicles SELECT.
 * Phase D — apply 20261231150000 (trips/drivers/customers/documents Owner-only fail-closed).
 *
 * Timestamp placement: after tip 20261231120000 (document_type…) so RBAC cannot sort ahead of
 * already-queued Dec 30/31 migrations. Re-check live schema_migrations before apply.
 *
 * NEVER: clear-table or shared fail-closed before Phase A + Phase B confirmation.
 */
export const ROLLOUT_PHASES: readonly string[] = [
  '0: client assigned-page RBAC (on branch)',
  'A: 20261231130000 helpers + page RPCs additive (unapplied) — apply FIRST',
  'B: deploy Admin UI RPC cutover + Edge page gates (local UI DONE; not deployed) — while old RLS still allows legacy JWT table access',
  'C: 20261231140000 clear-table + catalog page RLS (unapplied) — ONLY after B confirmed',
  'D: 20261231150000 shared-table Owner-only fail-closed (unapplied) — ONLY after B confirmed (and preferably after C)',
] as const;

/**
 * Exact page → operation mapping for admin_page_* (no broad any-related-page ORs).
 * Format: pageSlug: table.op[, …]
 */
export const EXACT_PAGE_OPERATION_MAP: readonly string[] = [
  'dashboard: trips.select, drivers.select, customers.select; admin_dashboard_period_stats; admin_dashboard_chart_rows; admin_sidebar_badge_counts',
  'active-trips: trips.select|update, drivers.select, customers.select',
  'trip-history: trips.select, drivers.select, customers.select (PaymentControlsCard default pageSlug=trip-history)',
  'missed-cancelled: trips.select|update, drivers.select, customers.select',
  'scheduled-rides: trips.select|update, drivers.select, customers.select',
  'manual-trip: trips.select|insert|update, drivers.select, customers.select; find_or_create_customer (self|manual-trip|service_role)',
  'fleet-tracking: trips.select, drivers.select',
  'dispatch: trips.select, drivers.select, customers.select',
  'corporate-billing|corporate-reports: trips.select, drivers.select',
  'riders: admin_list_riders_page; customers.select|update; trips.select',
  'pending-customer-signups|suspensions: customers.select|update',
  'live-chat: customers.select, drivers.select',
  'tickets: customers.select, drivers.select',
  'disputes: drivers.select (NewAdjustmentDialog)',
  'rider-feedback|lost-property: trips.select, drivers.select, customers.select',
  'documents|document-management: documents.select|update, drivers.select',
  'drivers: drivers.select|update|insert, documents.*, vehicles.select',
  'vehicles: vehicles.select, drivers.select (change-requests rehydrate via adminLookupByIds — no embed)',
  'services: drivers.select|update (primary SA clear); driver_service_areas stays direct (not Phase-3)',
  'regions: drivers.select (counts only)',
  'service-area-pricing: trips.select (ServiceAreaTripsTab); drivers.select (VoIP enrich)',
  'invoices|statement-runs|annual-taxi-report: drivers.select',
  'driver-wallet-ledger: trips.select (discount rows), drivers.select',
  'payout-ledger|commission-wallet: drivers.select; commission-wallet also vehicles.select',
  'payment-sessions|financial-reconciliation: trips.select via page RPC / Edges only — payment_sessions table stays authenticated-deny',
  'roles: Owner-only (staff_has_page_access / mutations); SA002 Owner bypass unchanged',
] as const;

/** Still open after Admin UI cutover (not Phase D blockers for shared-table JWT). */
export const REMAINING_OPEN_PATHS: readonly string[] = [
  'Admin UI src/: ZERO remaining .from(trips|drivers|customers|documents|vehicles) callers (re-scanned). Deploy of that UI is Phase B — not done.',
  'payment_sessions: authenticated still denied; UI must keep using gated Edges only.',
  'vehicles: NOT in Phase D fail-closed; SELECT page-gated via RPC; table RLS becomes page-gated only in Phase C (vehicles|drivers).',
  'driver_service_areas / profiles / service_areas / fare tables: not Phase D shared tables — still direct JWT where used (survive C+D).',
  'Edge requirePageAccess: app-level; deploy in Phase B. Do not apply Phase C catalog RLS before Edge+UI that expect own-role-only catalog reads.',
  'SA002 Owner + Roles & Permissions Owner-only: keep; do not broaden Roles mutations.',
] as const;

/** Unresolved / deferred page→data mappings (product) + apply-time risks. */
export const UNRESOLVED_PAGE_DATA_MAPPINGS: readonly string[] = [
  'receivables Admin/FM remaps deferred (matrix product).',
  'Annual Taxi Report / Revenue pages: drivers SELECT granted via annual-taxi-report|invoices|statement-runs; broader matrix assignment still product-owned.',
  'vehicles table Owner-only fail-closed not in 20261231150000 — decide whether a later wave should match trips/drivers/customers/documents.',
  'PaymentControlsCard pageSlug prop: callers must pass the hosting page (default trip-history); audit any host that is not trip-history/payment-sessions.',
  'APPLY RISK: 20261231130000 replaces staff_has_page_access (Batch3B role-string join + service_role-only EXECUTE) with role_id+Owner+authenticated EXECUTE. Existing DEFINER RPCs that call it (approve_corporate_request, find_or_create_customer, …) flip to role_id grants — confirm role_page_permissions.role_id is fully populated before Phase A.',
  'APPLY RISK: re-query live schema_migrations before apply; if tip > 20261231120000, renumber 311300/400/500 again.',
] as const;
