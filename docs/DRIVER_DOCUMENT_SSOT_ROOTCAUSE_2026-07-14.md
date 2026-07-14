# P0 — Driver Document Expiry SSOT: root-cause + fix (2026-07-14)

## Symptom

Admin → Document Review showed driver **Ahmed Osman (MK0001)** with three expired documents on 14 Jul 2026:

| Doc | Expired | Days ago |
|---|---|---|
| PHV licence | 11 Jul 2026 | 3 |
| DVLA driving licence | 9 Jul 2026 | 5 |
| PHD badge | 3 Jul 2026 | 11 |

The Driver App → Documents screen did not visibly show these as expired.

## Real root cause

There was **no supersession model** on `public.documents`. Multiple rows existed for the same `(driver_id, document_type)` — one expired, one renewed — and every reader picked a different row:

- Admin components queried `documents` without a "latest current" filter, so `ORDER BY updated_at DESC` was applied inconsistently or not at all, and the *older, expired* row often surfaced.
- Driver App `DocumentUpload.tsx` did `existingDocs.find(d => d.document_type === dt.slug)` — non-deterministic on duplicates. When it happened to land on the renewal it showed the doc as fine (but still with a green ✓ icon and no expired stat card, because status = `approved`).

Direct evidence — Ahmed's `phv_license` rows before the fix:

```
id                                    expiry_date  status
d01e6c60-47d3-44ae-a95e-344fbb842833  2026-07-11   approved   ← Admin was showing this
a3f19d68-4461-4c6a-ae93-0a19543e0cb9  2026-07-03   approved
ec1e0de9-ac2f-47e4-aa2a-582eec224952  2026-07-21   approved   ← latest renewal (correct)
```

Same pattern for `dvla_driving_license` (renewal → 2026-07-31) and `phd_badge` (renewal → 2026-07-16).

Additional contributing issues on the Driver App side (still worth fixing via the patch below, even now that the SSOT resolves the primary contradiction):

1. `getStatusIcon(doc.status)` returned a green ✓ for approved documents even when `isExpired` was true.
2. `stats.approved` counted expired documents as approved; no `Expired` stat card existed.
3. Client-side expiry math (`new Date(x) < new Date()`) — no timezone, no shared SSOT.
4. `useDocumentTypes` filters by `show_in_driver_app` but ignores `service_area_document_rules`.

## Fix (this repo)

**Migration `20260714_*_driver_document_compliance_ssot`:**

- Adds `is_current boolean` and `superseded_by uuid` on `public.documents`, with an index.
- Backfills `is_current` = latest `updated_at` per `(driver_id, document_type)`.
- Trigger `trg_documents_supersede` retires older rows automatically on every upload.
- View `public.driver_document_compliance_ssot` (`security_invoker=on`, `security_barrier=true`) joins `drivers × document_types × current documents` and returns one row per required doc-type with a backend-calculated `expiry_status` (`missing | pending | approved_valid | expiring_soon | expired | rejected | superseded`) using the **Europe/London calendar day**.
- RPC `public.get_driver_document_compliance(_driver_id uuid default null)` — drivers see their own compliance, admins/staff see any driver's. Both apps must call this.

**Admin hook:** `src/hooks/useDriverDocumentCompliance.ts` (consumes the RPC, exposes `reviewLabel` and `validityLabel` for the Admin's Review-vs-Validity split).

**Driver App patch:** see `docs/DRIVER_APP_DOCUMENT_SSOT_PATCH.md` (must be applied in the ONECAB Driver repo — Lovable cross-project is read-only).

## Verification — Ahmed Osman after fix

```sql
SELECT document_type_key, approval_status, expiry_date,
       expiry_status, days_until_expiry, is_superseded
FROM public.driver_document_compliance_ssot
WHERE driver_id = '5ed232c3-8bb5-4085-95d6-73e48e6c5e28'
  AND document_type_key IN ('phv_license','dvla_driving_license','phd_badge');
```

Result (14 Jul 2026):

| document_type_key | approval | expiry_date | expiry_status | days_until |
|---|---|---|---|---|
| phv_license | approved | 2026-07-21 | expiring_soon | 7 |
| dvla_driving_license | approved | 2026-07-31 | approved_valid | 17 |
| phd_badge | approved | 2026-07-16 | expiring_soon | 2 |

`documents.is_current` on the two older `phv_license` rows is now `false` with `superseded_by = ec1e0de9…`. Admin and Driver App now see the same current row.

## Acceptance status

- [x] Admin and Driver App consume the same SSOT.
- [x] Approval status and expiry status are separate dimensions.
- [x] No client-side expiry recomputation in Admin.
- [x] Duplicate document rows are marked superseded, not deleted.
- [x] `blocks_online` computed server-side from the same SSOT.
- [ ] Driver App patch applied in the ONECAB Driver repo (owner: user).

## Guardrails preserved

- Expired documents are still visible (never filtered out) — the SSOT always returns required-doc slots.
- Nothing is deleted; supersession is a flag.
- Auth/session unaffected.
- No hardcoding of the three flagged documents.
