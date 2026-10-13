# PR #80 — CLEAN ALL-GREEN RELEASE CERTIFICATION

**Final approved tip:** equals GitHub PR #80 `headRefOid` on `fix/capture-composition-ssot` after this push (authoritative; do not use earlier candidate tips).
**Atomic RPC ancestor:** `a1fca8bc13b852914fa8858f27f4d5c736a53ae3` — `git merge-base --is-ancestor` MUST be YES vs headRefOid.
**Prior candidates superseded:** `6bb0fed5`, `f36ec6bf`, `858a0fb8` (content ancestors; not the release tip).

**PR:** https://github.com/awehliye44-create/admin-new/pull/80 (draft)
**Project:** `thazislrdkjpvvghtvzo`

**Package SHA method:** `scripts/step82b31-closure-builder.ts` `sha256Dir` = deterministic sorted path+bytes (not mtime-sensitive tar).

---

## BLOCKER 1 — Cancellation/release 7/7 (resolved)

`tripLessPreauthReleaseLock` — **Choice B** (no production logic change):

- Removed brittle assert on missing comment `provider_state pre-flip`.
- Asserts executable order inside `markPaymentSessionReleased`:
  - `mutatePaymentSession` flips AUTHORISED→CANCELLED / COMPLETED→REFUNDED with `provider_state_verified_by: "markPaymentSessionReleased"`
  - **before** `markPaymentSessionStatus(..., "released", …)`
- Still references `prevent_authorised_session_client_cancel` (why flip-first is required).

**Result: 7/7 PASS**

---

## BLOCKER 2 — Unambiguous tip

1. `gh api .../pulls/80` → `head.sha` = final tip
2. `a1fca8bc…` is ancestor of that tip
3. Tip tree contains composition SSOT, atomic RPC, both migrations + rollbacks, tests, release docs

---

## Atomic RPC

`payment_session_acquire_capture_composition` — one PG txn under `pg_advisory_xact_lock(hashtext('capture_composition:'||session_id))`.

---

## target ≤ authorised

| Layer | Where |
|-------|--------|
| DB CHECK | `payment_sessions_capture_composition_populated_chk` |
| Atomic RPC under lock | `CAPTURE_TARGET_EXCEEDS_AUTHORISED` before persist + on resume |

---

## Migration-first

- Old Edges + new columns: safe (nullable / ignored)
- New Edges without RPC: `CAPTURE_COMPOSITION_MIGRATION_REQUIRED` fail closed

---

## PG17

PostgreSQL **17.11** ephemeral — both migrations applied — concurrency cert **PASS** (11 races).

---

## Regression

| Suite | Result |
|-------|--------|
| Composition + freeze + txn-atomic | 39/39 |
| Complete 113 matrix | 113/113 |
| Cancellation/release (tripLess) | **7/7** |
| Mutex / stale GET-first / historical / admin ownership | 9+7+6+10 PASS |
| PG17 concurrency | PASS |

---

## Deploy closure (8 Edges)

`submit-customer-trip-tip` **removed**: package has no composition/acquire imports; PR diff vs `a2afdea2` changes none of its runtime files (HTTP invokeFinalize only). Finalize deploy carries capture composition.

`capture-trip-payment` **DO NOT DEPLOY** (retired stub).

| Slug | Live ver | Rollback = live ezbr (full) | Files | Tip package SHA-256 (full) |
|------|----------|-----------------------------|------:|----------------------------|
| finalize-trip-and-capture | 535 | `897b6306d718c70569f0e76de773abacdb557ad834330bb35f6c4d95c3712971` | 75 | `ff10693c33531fae8166b7ce72a8d8d96909198718dae8cbe50437056c096365` |
| admin-capture-trip-payment | 308 | `533d7fa3a2a2cdc58667612ba8f076dda784a7346e9ba29f3e14ee1241317412` | 75 | `3b0b65ea0e63c1c66152f3bcc911b38003478270dd4bbfaec66620485abb308d` |
| admin-remediate-trip-payment | 121 | `2cb920ad2fb919e980c75f6431c5e8a15daeac42493a57351303dc58e82beb7a` | 80 | `9ea95cd15d4123b58e558b2f3bbc5db030b2067d4c4c7bcfb67421b919c15216` |
| capture-expired-tip-windows | 167 | `fdd70e6e405306e5de882e3b8eae801b0b1699467c4a977a350e0bd8dc6538fe` | 40 | `5ae92b411fede0dc9a42cf3755d8dc14c66bddd48974aa32166f0b9bd2051d00` |
| sweep-revolut-stale-holds | 176 | `a69bba897a18290aee242b0595adcddef38a567e3776e797677f2dc8f0b80e25` | 57 | `717e4772c26f93dd00958c16f5d7e292a2ad63a6dd29c0352036aa1e6e7b8408` |
| stop-workflow | 651 | `1f6b1d5f8a285991e4b105609d7436c8b6a66f7217b29e9d7ae6bed7fd54e543` | 91 | `258b44acb3e5386fffc5aada2080d707b7bb47ef52df22f93228e3fa002ed6c3` |
| revolut-webhook | 297 | `b86e0d4017f48e4d1114e36eb11a5ddc0f79be36620ae13d683ecdaf3d4b01da` | 52 | `b6937d859ce0c19f504ee98f4fd73897731e3c320ddc6fd63002f8625ba4e74b` |
| admin-hold-action | 136 | `3e72c4678e916ec7149c0fcf1e61ff3483ae8c71f0242b096f132f9296786067` | 53 | `1ab591b9da3f5e82f8155b7dbf52b2263a08dcf48937d43114ff338687dd2b4a` |

### Migration SHA-256

| File | SHA-256 |
|------|---------|
| `20261130120000_capture_composition_components.sql` | `323d723737c65692fb697b1e87505b19f53e71f16281fd989ad9cf607c6e28b2` |
| `rollback_20261130120000_…` | `615ccafff4769f4318d573040ffcc5b1455c24d3617a9d624da7cd3aaec9ca37` |
| `20261130130000_payment_session_acquire_capture_composition.sql` | `761c235e24fed675d994a69645bf18e7d244955ecc69b9fe6de5caca6baa6438` |
| `rollback_20261130130000_…` | `0c0d74ba682a7c8e445345280088081c7cbfda13a706ce55b18fdd503be00eef` |

### Deploy order (when approved)

1. Both forward migrations
2. Verify RPC + service_role EXECUTE only
3. Deploy the eight Edges above
4. Never deploy capture-trip-payment or submit-customer-trip-tip for this PR

---


## Source hygiene (post-release)

Live `schema_migrations` versions are `20261130120000` / `20261130130000` (filename timestamps aligned; original tip files were `2026092512/130000` and collided with `negotiation_decision_hold_sql_timeout`). Forward SQL content hashes unchanged. Headers inside forward SQL still cite the pre-rename rollback paths to preserve content SHA-256.

## Unchanged production fingerprint

OPEN 30p+6p · RESERVED/SETTLED/WAIVED 0 · MK-002 capture 500 once · TEN 425 · commission 75

FOLD_GATE_OFF · NO_MERGE · NO_MIGRATION · NO_DEPLOY · NO_LIVE_BOOK · NO_PROVIDER_MUTATION

**STOPPED_FOR_CLEAN_ALL_GREEN_RELEASE_APPROVAL**
