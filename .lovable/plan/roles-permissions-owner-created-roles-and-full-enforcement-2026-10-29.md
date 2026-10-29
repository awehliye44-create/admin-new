# Roles & Permissions: owner-created roles and full enforcement

## What exists today (audit)
- Six fixed roles (Super Admin, Admin, Operator, Finance Manager, Support, Compliance).
- Page access per role (`role_page_permissions`) and on/off action switches per role (`role_action_permissions`).
- The sidebar and a page gate already hide unassigned pages. The backend already checks access through two shared checks, used about 60 times: "has page access" and "has action".
- Gaps: owners can't create roles; actions are not split into View / Create / Edit / Delete / Approve / Export / Manage; many buttons, dashboard widgets and money figures ignore permissions; some backend paths check the fixed role name instead of permissions.

## Stage 1 — Owner-created roles + menu, page and backend checks
- New **roles** list: name, description, active, created by. The six current roles become editable starter roles. Super Admin stays locked as the owner role.
- Each staff member gets exactly one role from that list. Existing staff are moved across automatically, keeping their current access.
- Page and action permissions move from the fixed roles to the new roles list. There is still only one permission system.
- The two shared backend checks are changed to read the staff member's assigned role, so every existing backend check follows the owner's settings without being rewritten.
- Roles & Permissions page: create, rename, duplicate, deactivate and delete roles (delete is blocked while staff use the role), edit permissions, and see each role's permissions and staff count. Every change is recorded in Activity History.
- Only the owner, or roles with "Manage roles", can change roles. Nobody can give themselves more access or remove the last owner.
- Sidebar, page access and direct links follow the role. Hidden pages are also blocked by the backend.

## Stage 2 — Granular actions
- Every page gets View / Create / Edit / Delete / Approve / Export / Manage. Giving View does not give any other action.
- Buttons are hidden when the action isn't allowed: Edit, Delete, Approve, Export, Refund, Adjust Balance, Manage Settings. The matching backend operations check the same permission.

## Stage 3 — Sensitive data
- Field permissions: financial values, bank details, payment details, contact details.
- Dashboard widgets and financial statistics hidden without permission.
- The backend leaves restricted values out of its responses. `****` is shown only where a field has to stay visible.
- Search, notifications and reports respect page permissions.

## Stage 4 — Verification
- Tests for each rule (View alone gives no Edit; hidden page blocked by direct link; staff can't raise their own access; last owner protected).
- Sign in as a restricted test role and check the menu, pages and buttons.

## Technical details
- Tables: `staff_roles_catalog` (id, key, name, description, is_system, is_owner_role, is_active), plus `role_id` added to `role_page_permissions`, `role_action_permissions` and `staff_profiles`. Rows are backfilled from the `staff_role` enum. The enum columns are then removed under the permanent-cleanup rule, and anything that read the enum moves to `role_id`.
- `staff_has_page_access` and `staff_has_action` resolve through `staff_profiles.role_id`. Places that check the role name directly (for example `staff_has_company_funds_read_access`, finance gates in edge functions) move to action keys.
- Writes go only through security-definer functions with owner or `roles.manage` checks and an escalation guard. Permission tables stay read-only for the client.
- Backend changes that need redeploying are still affected by the existing upload size limit.
