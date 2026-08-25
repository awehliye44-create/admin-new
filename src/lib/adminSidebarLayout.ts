/**
 * Admin shell / sidebar layout stability SSOT (UI only).
 * Prevents sidebar jump on route clicks — no finance/backend coupling.
 */

export const ADMIN_SIDEBAR_EXPANDED_PX = 280;
export const ADMIN_SIDEBAR_COLLAPSED_PX = 64;
export const ADMIN_SIDEBAR_ITEM_HEIGHT_PX = 44;
export const ADMIN_SIDEBAR_COLLAPSED_KEY = 'admin-sidebar-collapsed';

export function adminSidebarWidthPx(collapsed: boolean): number {
  return collapsed ? ADMIN_SIDEBAR_COLLAPSED_PX : ADMIN_SIDEBAR_EXPANDED_PX;
}
