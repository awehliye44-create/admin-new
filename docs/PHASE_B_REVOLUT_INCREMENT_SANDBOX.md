# Phase B — Revolut same-order incremental authorisation

## Status (2026-08-06)

**Environment reclassified.** Supabase `thazislrdkjpvvghtvzo` is the approved **pre-production live-testing** backend (internal Customer / Driver / Admin end-to-end testing; not external customer launch; not a disposable sandbox).

**Revolut proof: LIVE.** Active merchant credentials are not sandbox. Payment transactions are **blocked** until separate controlled-live approval.

| Gate | Result |
|------|--------|
| Supabase target `thazislrdkjpvvghtvzo` | PASS (explicitly approved for Phase B under pre-prod live-testing rules) |
| Revolut sandbox credentials + sandbox base URL | **FAIL — live credentials in use** |
| Migration applied | **Applied** `20260806120000` (checksum `25096b21…0d2c`) |
| Edge deploy of Phase B functions | **Done** (7 functions ACTIVE) |
| Payment / webhook matrix | **Stopped** pending controlled-live approval |

## Revolut credential / base-URL proof

Source of truth on project `thazislrdkjpvvghtvzo`:

| Evidence | Value |
|----------|--------|
| `payment_provider_configs` (revolut) | `environment=live`, `status=live`, `is_enabled=true`, `is_primary=true` |
| Vault live `secret_key` (masked) | `sk_E3XM_••••wxR7` — **not** `sk_sandbox_` |
| Vault live `publishable_key` (masked) | `pk_Z1AZn••••pPdh` — **not** `pk_sandbox_` |
| Runtime classification in `revolutOrders.ts` | `key.startsWith("sk_sandbox") ? "sandbox" : "live"` → **live** |
| Merchant API base URL for live | `https://merchant.revolut.com/api` |
| Webhook endpoint | `https://thazislrdkjpvvghtvzo.supabase.co/functions/v1/revolut-webhook` |
| Last connection test | `2026-08-06T09:10:19Z` status `ok` against live config |
| Vault `test` row | mis-saved `publishable_key` holding same live-style `sk_E3XM_…` — **not** a sandbox merchant setup |

**Verdict:** Revolut testing would be **live**, not sandbox. Do not label sandbox. Do not use real payment instruments without controlled-live approval.

## Migration (single file only — never blanket `db push`)

| Item | Value |
|------|--------|
| Filename | `20260806120000_revolut_same_order_increment_ssot.sql` |
| SHA-256 | `25096b21c39c9f22b02b31c3bce6b786368e99903bae39bf85edbaf60fb80d2c` |
| Remote history | recorded in `supabase_migrations.schema_migrations` as `20260806120000` |
| Destructive statements | None (`DROP INDEX` of uniqueness that blocks same-order rows only; no DROP TABLE / TRUNCATE / DELETE) |

Objects:

- `payment_sessions.financial_operation_*` columns + check
- `payment_session_authorisations` increment columns + target uniqueness
- drop `payment_session_authorisations_provider_order_unique`
- authorised/captured amount checks
- `payment_webhook_events` + unique `(provider, provider_event_id)`

Rollback / forward-fix:

1. Stop deploying increment-enabled functions; redeploy prior function versions.
2. Leave additive columns / `payment_webhook_events` in place (safe).
3. Recreate old unique index only after confirming no same-order increment rows exist.

## Deploy scope (approved list only)

| Function | Remote today | Action when deploy approved |
|----------|--------------|-----------------------------|
| `update-preauth-on-trip-modification` | v324 ACTIVE | Redeploy Phase B build |
| `confirm-trip-modification-payment` | v54 ACTIVE | Redeploy Phase B build |
| `finalize-trip-and-capture` | v395 ACTIVE | Redeploy Phase B build |
| `admin-increment-revolut-authorisation` | **missing** | Deploy new |
| `revolut-webhook` | v74 ACTIVE | Redeploy Phase B build |
| `create-payment-recovery` | v17 ACTIVE | Redeploy Phase B build |
| `admin-recapture-trip-shortfall` | v2 ACTIVE | Redeploy Phase B build |

Do **not** redeploy unrelated functions. Do **not** replace secrets.

## Risk controls

- Protect existing live-test trips, payment sessions, ledgers, users — no truncate/reset/reseed/delete.
- Webhook tests: unique test IDs only; preserve provider event dedup; no replay of existing live-test payment events.
- Concurrency: newly created internal Phase B–tagged records only; no broad load tests.
- Tag every generated record as internal Phase B test where schema permits.
- If controlled live payments are later approved: authorised internal tester only, smallest practical amount, no destructive/repeated/load/uncontrolled concurrency tests.

## Exact approvals required (stop points)

1. **Next:** explicit approval to **apply only** `20260806120000_revolut_same_order_increment_ssot.sql` to `thazislrdkjpvvghtvzo` (no blanket push).
2. Then: explicit approval to **deploy only** the seven functions listed above.
3. Then (because Revolut is live): separate explicit approval for **each** controlled live-payment test — never proceed on environment gate alone.
