# Stage 2 — Read-only permission audit (no changes made)

## Current structure
- 75 admin pages; page access per role via `role_page_permissions` (79 slugs for the Owner role).
- Action switches exist for only 2 modules (14 keys in `role_action_permissions`):
  - roles_permissions: view, create_role, edit_role, delete_role, assign_role, assign_service_areas, manage_permissions, view_audit_log (owner-only, non-delegable)
  - demand_zones: view, configure_surge, configure_heatmap, configure_colours, recompute, view_audit
- Frontend action checks: 11 calls across 5 files. Every other button (create/edit/delete/approve/export) shows
  to anyone who can open the page.
- Backend: 58 edge functions gate by admin/staff/finance role; database page checks used for only 7 areas
  (account-requests, corporate-accounts, lost-property, user-directory, statement-runs, manual-trip, drivers).
  No edge function checks an individual action key.

## Gaps
1. No View/Create/Edit/Delete/Approve/Export/Manage split for any module except Demand Zones.
2. Buttons are not hidden when an action is not granted.
3. Server checks are role-based (admin/finance) rather than permission-based, so a custom role cannot be
   limited to "view only" on the server.
4. Exports (CSV) are client-side and ungated.
5. Dashboard widgets are not tied to permissions (Stage 3 scope).

## Proposed approach (for review)
- One action catalogue: `<module>.<view|create|edit|delete|approve|export|manage>` for each module, only where the action exists.
- Seed every existing role with its current effective access, so nothing changes for staff on day one.
- Owner matrix UI: module rows x action columns.
- Frontend: one `can(action)` helper hides buttons/menus.
- Backend: shared `requireStaffAction(key)` in edge functions + `staff_has_action` in RPC/RLS, rolled out module by module,
  starting with Finance/Payouts, Drivers, Riders, Trips, Service Areas, Corporate.
