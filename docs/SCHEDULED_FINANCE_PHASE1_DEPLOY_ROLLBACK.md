# Scheduled Finance Phase 1 — Deploy & Rollback

**Status:** Release branches prepared. Production deploy awaits **explicit final approval**.

Isolated branch: `release/scheduled-finance-phase1` (excludes trip-capture-deferral).

Milton Keynes must remain: `enable_preauth_buffer=false`, `buffer_value=2`.
Only approved dispatch change: `max_advance_days = 5`. Do not touch waves / commission / airport / wallet / stacking.

## Isolated release tips (local; not production-pushed until approval)

| Repo | Branch | Tip |
|------|--------|-----|
| admin-new | `release/scheduled-finance-phase1` | see `git rev-parse HEAD` |
| onecab-central-hub | `release/scheduled-finance-phase1` | BookRide only |
| onecab-customer-native | `release/scheduled-finance-phase1` | schedule window only |

Preserve `release/trip-capture-deferral` (capture-deferral work). Do not delete it.

## Migrations (apply in order via guarded single-file apply)

Use `scripts/build-guarded-migration-apply.py` per file — **never** blind `supabase db push` while remote-only history skew exists.

1. `20270201120000_scheduled_finance_phase1_capture_deadline.sql`
2. `20270201120100_scheduled_finance_phase1_gap_closure.sql`
3. `20270201120200_scheduled_finance_phase1_payment_first_atomicity.sql`

## Dependency-aware cutover (no unpaid card trips)

| Step | Action | Notes |
|-----:|--------|-------|
| 0 | Pause corporate **card** BookRide only if needed (invoice/wallet stay up) | Instant Customer card stays on CTAP |
| 1 | Apply migration **120000** (additive columns + helpers + `max_advance_days=5`; latch default false) | Safe additive |
| 2 | Deploy Edge: `create-trip-after-payment`, `create-corporate-book`, `confirm-revolut-payment`, `validate-scheduled-booking`, `scheduled-dispatch`, webhook/increment deadline persist | Clients must not call missing RPCs yet |
| 3 | Apply **120100** (advance trigger, gated accept/activate) | |
| 4 | Publish **hub** Phase1 BookRide (CTAP) to `co.onecab.net` | Before strict payment-first if avoiding card errors |
| 5 | Publish **Admin** (`adminonecab.net` via GitHub Pages workflow on `main`) | Assign Now RPC after 120200 |
| 6 | Apply **120200** (payment-first trigger + mod coverage + `admin_assign_scheduled_driver`) | Fail-closed backstop |
| 7 | Customer OTA: channel `production`, runtimes `1.0.5(22)` iOS / `1.0.5(45)` Android | JS-only schedule picker — OTA-compatible |
| 8 | Backfill capture deadlines (authoritative Revolut retrieve); dry-run normalise terminal `payment_gate_blocked` | No mass-cancel |
| 9 | Flip `scheduled_capture_coverage_enforced=true` only after backfill verification | Legacy latch only |

**Expected corporate card downtime:** ideally **0** if hub ships before 120200; worst case **~5–15 minutes** fail-closed if 120200 lands while old hub still serves `pending_payment` inserts. Invoice / Commission Wallet / instant Customer bookings remain operational. Do not interrupt active journeys.

Pause/resume: feature-flag or temporary hub card CTA disable → publish hub → enable. No booking cancels.

## Publishing paths (verified)

| Surface | Path | Evidence |
|---------|------|----------|
| Admin | GitHub Actions `Deploy Admin Panel` → GitHub Pages → **adminonecab.net** | `.github/workflows/deploy-github-pages.yml`; `gh api .../pages` cname |
| Hub | Lovable Share → Publish → **co.onecab.net** | Hub README Lovable publish; `MAPBOX_REFERER` default `https://co.onecab.net/` |
| Customer OTA | EAS Update project `059e7e87-…`, channel **production** | `eas.json` + `app.config.ts` runtimes |
| Driver | Not required for Phase 1 | No Phase 1 Driver dependency identified |

## SQL rollback pack (reverse order)

| Script | Effect |
|--------|--------|
| `rollback_20270201120200_…atomicity.sql` | Drop mod-coverage trigger + `admin_assign_scheduled_driver`. **Keeps payment-first trigger.** |
| `rollback_20270201120200_drop_payment_first_OPTIONAL.sql` | Drops payment-first — **DANGER** (unpaid inserts). Only after CTAP-only clients. |
| `rollback_20270201120100_…gap_closure.sql` | Drop advance trigger; restore prod `accept_scheduled_ride` / `activate_paid_corporate_trip`; restore 120000 `assert_payment_gate`. |
| `rollback_20270201120000_…capture_deadline.sql` | Restore pre-Phase1 `assert_payment_gate`; drop helpers; **keep** deadline columns; **keep** `max_advance_days=5`; force latch false. |

### Rollback sequencing with Edge/clients

1. Redeploy previous Edge revisions for CTAP / corporate-book / dispatch / confirm / webhook.
2. Redeploy previous Admin + hub builds (or hub CTAP-safe build).
3. Run SQL rollbacks **120200 → 120100 → 120000**.
4. Do **not** run optional payment-first drop unless unpaid-insert risk is accepted and mitigated.
5. Instant digital payment gate (`enforce_digital_payment_gate`) is never removed by these scripts.

## Remote-only migration history

Nine production versions have no local file (hotfix / ops applies). Do **not** repair history without approval. Phase 1 applies safely via **guarded per-file apply** of the three `20270201120*` files only — does not apply unrelated local migrations.
