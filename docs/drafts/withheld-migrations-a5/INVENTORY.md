# A5 — Withheld migrations inventory (Admin)

**Base:** `origin/main` = `b4ad7212`  
**Evidence tip:** `rescue/admin-migrations-rollbacks-20260914` @ `57bbab2b`  
**Drafts tip:** `rescue/admin-a8b28f-drafts-20260914` @ `39679444` — **zero** migrations not already on main.

## Classification legend

| Class | Meaning |
|---|---|
| REQUIRED | Package for review; apply only with Ahmed approval |
| SUPERSEDED | Intermediate body replaced by a later migration |
| INVALID | Must not apply as named (timestamp collision or corrupt) |
| DEFERRED | Valid but belongs to another workstream |
| REJECTED | Do not ship |

## Forward files not on `origin/main`

| File | Class | Reason |
|---|---|---|
| `20261108180000_driver_snapshot_financial_model_passthrough.sql` | DEFERRED | FM stamp passthrough — pair with driver financial-stamp workstream |
| `20261108190000_scheduled_jobs_financial_model_passthrough.sql` | DEFERRED | Same FM family as 081800 |
| `20261108200000_trip_history_financial_model_passthrough.sql` | INVALID | Timestamp collides with main `20261108200000_corporate_suspended_booking_digital_only_lock.sql` — retimestamp before any packaging |
| `20261109420000_phase_a8b28_can_corporate_user_view_driver_self_bind.sql` | REQUIRED | Packaged: `review/admin-a5-a8b28-self-bind-20260915` |
| `20261109510000_phase_tip_window_deferral_columns.sql` | REQUIRED | Packaged in tip-window REQUIRED set |
| `20261109520000` … `20261109550000`, `20261109570000` has_work steps | SUPERSEDED | Replaced by `096000` final has_work |
| `20261109560000_phase_tip_window_column_write_lock.sql` | REQUIRED | Packaged in tip-window REQUIRED set |
| `20261109580000_phase_tip_refund_reverses_captured_tip.sql` | REQUIRED | Packaged in tip-window REQUIRED set |
| `20261109590000_phase_tip_retire_legacy_completion_triggers.sql` | REQUIRED | Packaged in tip-window REQUIRED set |
| `20261109600000_phase_tip_window_expiry_has_work_session_order.sql` | REQUIRED | Packaged in tip-window REQUIRED set |
| `20261109610000_whatsapp_guest_auth_user_id_by_exact_phone.sql` | DEFERRED | WhatsApp guest booking train |
| `20261109620000_customer_phone_allows_same_user_driver.sql` | DEFERRED | Identity/booking — not tip/A8B28 |

## Packaging branches (this release train)

1. **A8B28 self-bind** — `review/admin-a5-a8b28-self-bind-20260915`
2. **Tip window REQUIRED** — `review/admin-a5-tip-window-required-20260915` (excludes SUPERSEDED has_work steps)
3. **Inventory-only** — this document on `review/admin-a5-migrations-inventory-20260915`

## Hard rules

- Never combine FM + A8B28 + tip + WhatsApp into one PR.
- Never apply SQL without Ahmed approval.
- Never use migration version `20260915120000` (A4 collision — separate).
- Candidate A4 version `20261112180000` remains unapproved until schema_migrations live max is rechecked at apply time.
