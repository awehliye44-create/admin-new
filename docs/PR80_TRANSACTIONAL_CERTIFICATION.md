# PR #80 — FINAL TRANSACTIONAL CERTIFICATION

**Frozen tip (this certification):** `a1fca8bc13b852914fa8858f27f4d5c736a53ae3` (docs stamp on branch tip; parent candidate `6bb0fed5`)  
**PR:** https://github.com/awehliye44-create/admin-new/pull/80 (draft)  
**Project:** `thazislrdkjpvvghtvzo`

## CRITICAL — LOCK LIFETIME (PASS)

### Exact RPC

`public.payment_session_acquire_capture_composition(uuid, text, integer, integer, integer, integer, text, text)`

Migration: `supabase/migrations/20260925130000_payment_session_acquire_capture_composition.sql`

### Full SQL transaction boundary

Edge calls **one** `supabase.rpc('payment_session_acquire_capture_composition', …)`.

In PostgreSQL, a single `SELECT function(...)` / RPC statement runs inside **one transaction**.  
`pg_advisory_xact_lock` is held until **that transaction commits** (when the RPC returns to Edge).

Inside the function body (same transaction, no network round-trip):

1. `PERFORM pg_advisory_xact_lock(hashtext('capture_composition:' || p_payment_session_id::text))`
2. `SELECT * FROM payment_sessions WHERE id = … FOR UPDATE`
3. Resume path if `capture_idempotency_key` already set (never recompute)
4. Else `SELECT … FROM payment_session_receivable_allocations … FOR UPDATE OF a` then `sum(RESERVED)`
5. Create plan OR fail closed OR `legacy_fare_tip` (no receivable evidence only)
6. `UPDATE … SET` components + `capture_idempotency_key` + `capture_composition_frozen_at` + `CAPTURING`  
   `WHERE capture_idempotency_key IS NULL` (first writer wins)
7. If update count 0 → re-read `FOR UPDATE` and **adopt** winner plan
8. `RETURN jsonb` frozen plan

**Proof no Edge multi-round-trip:** `captureCompositionAcquireSSOT.ts` calls only this RPC for plan identity; source lock forbids `loadReservedAllocations` / `persistFrozenPlan` / `decideCaptureCompositionAction` / `planCaptureComposition(` on the acquire path. Missing RPC → `CAPTURE_COMPOSITION_MIGRATION_REQUIRED` (fail closed).

### Lock key formula

```
hashtext('capture_composition:' || payment_session_id::text)
```

### FOR UPDATE rows

- `payment_sessions` row for the session
- all `payment_session_receivable_allocations` rows for that session with `status = 'RESERVED'`

### Concurrent callers

Loser blocks on `advisory_xact_lock`, then either:
- finds frozen plan → `kind: resumed` (same target + same idempotency key), or
- loses `WHERE capture_idempotency_key IS NULL` race → re-read → adopt winner

### Isolated Postgres concurrency (real 2-txn)

Script: `scripts/capture-composition-txn-concurrency-cert.sh`  
DB: local Homebrew PG 16 ephemeral `onecab_capture_composition_cert` (not production)

| Result | Value |
|--------|-------|
| Worker A | `created` target **536** |
| Worker B | `resumed` target **536** |
| Idempotency key | identical one key |
| Session components | fare 500 + tip 0 + recv **36** |
| Fare-only fallback | **NONE** |
| Half-plan | **NONE** |
| Deadlock | **NONE** (11 races: 1 primary + 10 pairs) |
| Verdict | **PASS** |

---

## MIGRATION CERTIFICATION (PASS)

| Control | Evidence |
|---------|----------|
| Populated plan sum CHECK | `payment_sessions_capture_composition_populated_chk` |
| Every component ≥ 0 | same CHECK |
| Target ≤ known authorised | same CHECK vs `total_authorised_amount_pence` / `authorised_amount_pence` |
| All-or-none required fields | NULL set XOR full populated set |
| Immutable after `capture_composition_frozen_at` | trigger `trg_payment_sessions_capture_composition_immutable` → `CAPTURE_COMPOSITION_FROZEN_IMMUTABLE` |
| Initial write via service-role path | SECURITY DEFINER RPC + `auth.role() = service_role`; Edge service role only |
| Subsequent component/key changes rejected | trigger (local probe PASS) |
| authenticated/anon cannot mutate / execute | REVOKE from anon+authenticated; EXECUTE grant **service_role only** (`anon_exec=f auth_exec=f service_exec=t`) |
| Existing table RLS covers new columns | migration comment + existing `"Service role manages payment_sessions"`; no redundant policies |
| Rollback refuses used live evidence | `rollback_20260925120000_…` DO guard raises `ROLLBACK_REFUSED_LIVE_CAPTURE_COMPOSITION_EVIDENCE` |
| Migration-first + old Edges | columns nullable; old Edges ignore → safe |
| New Edge + missing migration | `CAPTURE_COMPOSITION_MIGRATION_REQUIRED` → fail closed |

### Migration SHA-256 (full)

| File | SHA-256 |
|------|---------|
| `20260925120000_capture_composition_components.sql` | `323d723737c65692fb697b1e87505b19f53e71f16281fd989ad9cf607c6e28b2` |
| `rollback_20260925120000_capture_composition_components.sql` | `615ccafff4769f4318d573040ffcc5b1455c24d3617a9d624da7cd3aaec9ca37` |
| `20260925130000_payment_session_acquire_capture_composition.sql` | `761c235e24fed675d994a69645bf18e7d244955ecc69b9fe6de5caca6baa6438` |
| `rollback_20260925130000_payment_session_acquire_capture_composition.sql` | `0c0d74ba682a7c8e445345280088081c7cbfda13a706ce55b18fdd503be00eef` |

---

## FULL REGRESSION

| Suite | Result |
|-------|--------|
| Composition + freeze/race + txn-atomic source locks | **39/39 PASS** (20+16+3; prior “36” was 20+16) |
| Complete 113-case matrix | **113/113 PASS** |
| Tip state machine | **15/15 PASS** (in 113) |
| Early-capture locks | **8/8 PASS** (in 113) |
| Terminal-dispose locks | **13/13 PASS** (in 113) |
| Stale GET-first reclaim | **7/7 PASS** |
| Mutex security locks | **9/9 PASS** |
| Receivable lifecycle / concurrency | **35+3 PASS** (in 113) |
| Cancellation/release (tripLess) | **6/7 PASS** — 1 pre-existing source-comment drift (`provider_state pre-flip` absent at `6bb0fed5`; not introduced by txn RPC) |
| Policy A | **3/3 PASS** (in 113) |
| Historical compatibility (tipWindowCompat) | **6/6 PASS** |
| Canonical tip integration | **15/15 PASS** |
| Admin capture ownership | **10/10 PASS** |
| Provider ordering | **4/4 PASS** |
| Isolated PG concurrency | **PASS** (11 races) |

---

## PACKAGE CERTIFICATION

Closures: `/tmp/pr80-closures-txn` via `step82b31-closure-builder.ts` (unresolved=0).

Live versions / rollback = current production ezbr (redeploy previous package).  
Live ezbr from prior read-only inventory (unchanged — **no deploy this session**):

| Slug | Deploy? | Live ver | Rollback = live ezbr (full) | Tip files | Tip package SHA-256 (full) |
|------|---------|----------|-----------------------------|----------:|----------------------------|
| finalize-trip-and-capture | **YES** | 535 | `897b6306d718c70569f0e76de773abacdb557ad834330bb35f6c4d95c3712971` | 75 | `9c11034aadbdac5df11fba8438c0c317c2fccb3f200f1059c7adf027cfbb656d` |
| admin-capture-trip-payment | **YES** | 308 | `533d7fa3a2a2cdc58667612ba8f076dda784a7346e9ba29f3e14ee1241317412` | 75 | `368308141c5808c9b7007a9b2151c5d3012873fab601c985d97138c9b1ebdd7a` |
| admin-remediate-trip-payment | **YES** | 121 | `2cb920ad2fb919e980c75f6431c5e8a15daeac42493a57351303dc58e82beb7a` | 80 | `9bc4ed58d160bbb43e2064264ff7fa7b796ed0e400def879fefb3a3aef893a4b` |
| capture-expired-tip-windows | **YES** | 167 | `fdd70e6e405306e5de882e3b8eae801b0b1699467c4a977a350e0bd8dc6538fe` | 40 | `50154eed7ce642c9f149ab48c4ef6245394e967154f9618c5ed34ee88b8e6e36` |
| submit-customer-trip-tip | **YES** | 80 | `bc9f6f4e1904e657fb031b9f96c5f36577c1afba2a6a73311cfdefafa113dea5` | 11 | `b87d3c44566155dcd59a6b7c939e64e98422e1208b2343eff4bf8e5f4e927f45` |
| sweep-revolut-stale-holds | **YES** | 176 | `a69bba897a18290aee242b0595adcddef38a567e3776e797677f2dc8f0b80e25` | 57 | `6f8cdac9d0080872a9a993c27336f1a3e31f4709e87e638530cac506b05e3e9d` |
| stop-workflow | **YES** | 651 | `1f6b1d5f8a285991e4b105609d7436c8b6a66f7217b29e9d7ae6bed7fd54e543` | 91 | `0ab80a8c100144cd5c9678fc98d1dad64cca8a216c893aa02d3788c7e7231721` |
| revolut-webhook | **YES** | 297 | `b86e0d4017f48e4d1114e36eb11a5ddc0f79be36620ae13d683ecdaf3d4b01da` | 52 | `bdd34981754ffbb27342a848b6a3ceb350e641e1d4a133912b4e47960c0ad702` |
| admin-hold-action | **YES** | 136 | `3e72c4678e916ec7149c0fcf1e61ff3483ae8c71f0242b096f132f9296786067` | 53 | `5740d1e21d816d507bc3a56b9e98a18e45b291986375ee64350260a8720aaeb6` |
| capture-trip-payment | **NO — retired stub** | 568 | `fbdd3c0073e7be6861bc124c27fef96f5465b9f229e2f9e1b6778ecb61d05ac6` | 5 | `d5abb7ec451eaae1924e5181d2d81ebf3c5939d69d756c2efd3464584cbd7a1d` |

---

## Exact migration-first deployment order (when approved)

1. Apply `20260925120000_capture_composition_components.sql`
2. Apply `20260925130000_payment_session_acquire_capture_composition.sql`
3. Verify RPC exists + service_role EXECUTE only
4. Deploy Edges (independent packages): finalize → admin-capture → admin-remediate → capture-expired-tip-windows → submit-customer-trip-tip → sweep-revolut-stale-holds → stop-workflow → revolut-webhook → admin-hold-action
5. **Do not** deploy `capture-trip-payment`

Fold gate remains **OFF** (`CUSTOMER_RECEIVABLE_FOLD_ENABLED=false`).

---

## Unchanged financial fingerprint

- MK-012 OPEN **30p** · MK-017 OPEN **6p**
- RESERVED / SETTLED / WAIVED **0** (incident receivables)
- MK-260925-002 captured **500p once** · TEN **425** · commission **75**
- No provider / wallet / Book / migrate / deploy this session

---

## Gates

FOLD_GATE_OFF · NO_LIVE_BOOK · NO_PROVIDER_MUTATION · NO_MERGE · NO_MIGRATION · NO_DEPLOY  

**STOPPED_FOR_TRANSACTIONAL_RELEASE_APPROVAL**
