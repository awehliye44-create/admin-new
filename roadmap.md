## Fix pre-existing typecheck build errors (batch 2026-09-02)

- [x] Fix pre-existing typecheck build errors (2026-09-03)

## Telemetry outage isolation

- [x] Make browser telemetry non-blocking during Supabase/Cloudflare outages
- [x] Sanitize telemetry storage failures without exposing upstream HTML
- [x] Verify focused tests, typecheck, and preview build

## Driver preset offer access

- [x] Verify and restore trip-specific access for the offered driver without exposing unrelated trips
- [x] Test authorization and negotiation gates; resolve the selected monitoring finding
- [ ] Deploy the corrected offer service — blocked by the existing 5.3 MB shared-code upload exceeding the 4.5 MB limit

## Roles & Permissions (owner-created roles)

- [x] Stage 1: roles list, staff and permissions on role_id, backend checks, role management UI
- [ ] Stage 2: granular View/Create/Edit/Delete/Approve/Export/Manage actions per page, enforced on buttons and backend
- [ ] Stage 3: field-level hiding/masking, dashboard widgets, search/notifications/reports
- [ ] Stage 4: restricted test role walkthrough and rule tests
- [ ] Deploy updated finance/payment/lost-property services — blocked by the shared-code upload size limit
