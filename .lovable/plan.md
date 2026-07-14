# P0 — Driver Document Expiry SSOT (Canonical Fix)

## Root-cause evidence (Ahmed Osman MK0001, 14 Jul 2026)

| Doc type | Row id | Status | Expiry | Days expired |
|---|---|---|---|---|
| phv_license | d01e6c60… | approved | 2026-07-11 | 3 |
| phv_license | a3f19d68… | approved | 2026-07-03 | 11 (duplicate) |
| dvla_driving_license | 99d9ea67… | approved | 2026-07-09 | 5 |
| phd_badge | 77ec783c… | approved | 2026-07-03 | 11 |

**Why Admin shows Expired and Driver App doesn't visibly show it:**
1. Driver App `DocumentUpload.tsx` renders the expired badge (orange) **but** the status icon stays green (`getStatusIcon(doc.status)` uses raw `status='approved'`), and `stats.approved` counts expired docs → screen reads as compliant.
2. `useDocumentTypes` ignores `service_area_document_rules`; expiry is recomputed client-side with `new Date()` (no TZ/SSOT).
3. `.find()` on duplicate rows per slug is non-deterministic (no `is_current` concept).
4. Admin uses `src/lib/driverDocumentCompliance.ts` (Europe/London SSOT). Driver App has its own duplicated logic.

## Fix — one backend SSOT, both apps consume it

### 1. Database migration (this Supabase, shared by both apps)

- Add columns to `public.documents`:
  - `is_current boolean not null default true`
  - `superseded_by uuid null references public.documents(id) on delete set null`
- Trigger `trg_documents_mark_superseded`: on insert/update of a `(driver_id, document_type)` row, set older approved rows for the same pair to `is_current=false`, `superseded_by=new.id`.
- Backfill: for every `(driver_id, document_type)` group, keep only latest `updated_at` as current.
- SECURITY DEFINER view `public.driver_document_compliance_ssot` (`security_invoker=off`, `security_barrier=true`) joining `drivers` × `document_types` × `documents` and returning per required doc-type:
  - `driver_id`, `document_type_id`, `document_type_key`, `display_name`
  - `document_id`, `approval_status`, `expiry_date`
  - `expiry_status` ∈ (`missing`, `pending`, `approved_valid`, `expiring_soon`, `expired`, `rejected`, `superseded`) — computed with Europe/London calendar (`(expiry_date AT TIME ZONE 'Europe/London')::date`)
  - `days_until_expiry`, `is_required`, `is_current`, `is_superseded`, `blocks_online`, `replacement_document_id`, `last_updated_at`
- RPC `public.get_driver_document_compliance(_driver_id uuid default null)` — returns SSOT rows for the caller's canonical driver (resolves via `drivers.user_id = auth.uid()`) or, for admin/staff, any driver.
- Grants: `EXECUTE` to `authenticated`; `SELECT` on view to `authenticated` (RLS via wrapper).

### 2. Admin UI (this repo)

- `src/components/documents/*` and any driver-detail doc panel: split ambiguous "Status" into two columns:
  - **Review status**: Approved / Pending / Rejected
  - **Validity status**: Valid / Expiring soon (n days) / Expired (n days ago) / N/A
- Consume the new RPC instead of ad-hoc queries where possible; keep `driverDocumentCompliance.ts` as a thin wrapper that now trusts server `expiry_status`.

### 3. Driver App patch (handed off, separate repo)

Produce `docs/DRIVER_APP_DOCUMENT_SSOT_PATCH.md` with copy-pasteable diffs:
- Replace `DocumentUpload.tsx` merge/filter logic with a call to `supabase.rpc('get_driver_document_compliance')`.
- Delete client-side `isExpired` / `new Date()` comparisons.
- Fix `getStatusIcon` to switch on server `expiry_status` (`expired` → red AlertCircle, `expiring_soon` → orange, etc.).
- Fix `stats` to derive from `expiry_status` (`Approved` count excludes expired).
- Add an "Expired" stat card and reorder list: Expired → Rejected → Missing → Expiring soon → Pending → Valid.
- Update `useDriverApproval.ts` to consume the RPC (delete duplicate expiry math).
- **User applies the patch** in the Driver App project (Lovable cross-project is read-only).

### 4. Evidence & tests

- SQL audit script under `scripts/sql/driver-document-ssot-audit.sql` (dupes, non-canonical driver_id, orphan document rows).
- Vitest in this repo covering: approved+valid, approved+expiring, approved+expired, rejected, missing, pending replacement, expired+valid replacement, TZ boundary at 23:59 London.
- `docs/DRIVER_DOCUMENT_SSOT_ROOTCAUSE_2026-07-14.md` — full root-cause + before/after evidence for MK0001.

## Acceptance

- Admin driver-detail doc list shows Ahmed's PHV / DVLA / PHD as Approved (review) + Expired (validity), with days-expired.
- New RPC returns 3 `expired` rows for Ahmed; running the RPC as Ahmed (via Driver App) returns the same list.
- After Driver App patch is applied there, expired docs show a red icon and "Expired X days ago", not a green check.
- Duplicate `phv_license` row is marked `is_current=false`.
- `can_go_online` (server-computed) is `false` for Ahmed until renewals are uploaded and approved.

## Out of scope (explicit)

- I cannot push commits into the ONECAB Driver repo; that patch is handed off as a document.
- No change to auth/session behaviour — expired docs block GO Online only, they do not sign the driver out.
- No hardcoding of the three flagged documents; the fix is data-driven across all required types.
