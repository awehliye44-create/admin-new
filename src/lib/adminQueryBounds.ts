/**
 * Admin list / dashboard fetch bounds.
 * Prefer count/aggregate queries over hydrating every row for KPIs.
 * Page sizes are request caps — full history remains reachable via pagination.
 */

/** Drivers table page size (server-side range). */
export const ADMIN_DRIVERS_PAGE_SIZE = 50;

/** Riders table page size (server-side range). */
export const ADMIN_RIDERS_PAGE_SIZE = 50;

/** Support inbox newest-first page size. */
export const ADMIN_SUPPORT_INBOX_PAGE_SIZE = 50;

/** Missed/Cancelled trips page size within the selected date window. */
export const ADMIN_MISSED_CANCELLED_PAGE_SIZE = 100;

/**
 * Missed/Cancelled range-wide fare-impact aggregate — max lightweight
 * fare-column rows hydrated for the date-range totals. KPI counts use
 * head-count queries, not this list.
 */
export const ADMIN_MISSED_CANCELLED_STATS_ROW_CAP = 2_000;

/**
 * Dashboard chart series — max completed/cancelled rows hydrated for bucketing.
 * KPI totals use head counts, not this list.
 */
export const ADMIN_DASHBOARD_CHART_ROW_CAP = 2_000;

/** Live fleet map — online drivers with GPS (ops surface; keep bounded). */
export const ADMIN_DASHBOARD_LIVE_FLEET_CAP = 500;

/** Active Trips ops board — live statuses only; hard cap prevents full-table hydrate. */
export const ADMIN_ACTIVE_TRIPS_CAP = 500;

/** Active Trips reassign picker — online approved drivers. */
export const ADMIN_ACTIVE_TRIPS_ONLINE_DRIVERS_CAP = 500;

/** Scheduled Rides board — upcoming non-terminal scheduled trips. */
export const ADMIN_SCHEDULED_RIDES_CAP = 500;

/** Scheduled Rides assign picker — approved drivers. */
export const ADMIN_SCHEDULED_RIDES_DRIVERS_CAP = 500;

/** Support Tickets (non–live-chat) board page size. */
export const ADMIN_SUPPORT_TICKETS_PAGE_SIZE = 50;

/** Corporate accounts list page size. */
export const ADMIN_CORPORATE_ACCOUNTS_PAGE_SIZE = 100;
