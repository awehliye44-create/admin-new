# PR #80 — CLEAN ALL-GREEN RELEASE CERTIFICATION

**Final approved tip:** `858a0fb8a473cc3a9ac4b1bb6bba3c483e2fe7b9` (all-green content). PR headRefOid may be this docs-stamp child tip — both include full tree.  
**Content tip (all-green commit):** `858a0fb8a473cc3a9ac4b1bb6bba3c483e2fe7b9` — tripLess 7/7, PG17 roles, package hashes, deploy closure correction.  
**Atomic RPC ancestor:** `a1fca8bc13b852914fa8858f27f4d5c736a53ae3` — must be ancestor of final tip (`git merge-base --is-ancestor` YES).  
**Parent candidate replaced:** `6bb0fed5`  

**PR:** https://github.com/awehliye44-create/admin-new/pull/80 (draft)  
**Project:** `thazislrdkjpvvghtvzo`

---

## BLOCKER 1 — Cancellation/release 7/7 (resolved)

`tripLessPreauthReleaseLock` test `markPaymentSessionReleased flips provider_state before status cancelled`:

- **Choice B** — brittle comment-only assert (`provider_state pre-flip`) replaced with executable-order proof.
- **No production logic change** — `paymentSessionSSOT.markPaymentSessionReleased` already flips `provider_state` via `mutatePaymentSession` (AUTHORISED→CANCELLED / COMPLETED→REFUNDED) **before** `markPaymentSessionStatus(..., "released", …)`.
- Test now asserts: flip `verified_by` index **<** status call index; CANCELLED/REFUNDED branch present; `prevent_authorised_session_client_cancel` still documented.

**Result: 7/7 PASS**

---

## BLOCKER 2 — Unambiguous tip

Proven at certification:

1. `gh pr view 80 --json headRefOid` → fills **Final approved tip**
2. `git merge-base --is-ancestor a1fca8bc… <final-tip>` → YES
3. Final tip contains: composition SSOT + atomic RPC + both forward migrations + both rollbacks + locks/tests + release docs

---

## Atomic RPC (unchanged)

`payment_session_acquire_capture_composition` — one PG txn:  
`advisory_xact_lock(hashtext('capture_composition:'||session_id))` → FOR UPDATE session → FOR UPDATE RESERVED → create/resume freeze → return plan.

---

## target ≤ authorised — where enforced

| Layer | Enforcement |
|-------|-------------|
| **DB CHECK** | `payment_sessions_capture_composition_populated_chk`: `provider_capture_target_pence <= COALESCE(total_authorised_amount_pence, authorised_amount_pence)` when populated |
| **Atomic RPC under lock** | Before persist: `IF v_auth > 0 AND v_target > v_auth THEN return CAPTURE_TARGET_EXCEEDS_AUTHORISED`; resume path same |

Both layers. RPC fails closed under lock before write; CHECK is the durable invariant.

---

## Migration-first

| Scenario | Behaviour |
|----------|-----------|
| Old Edges + new columns | Columns nullable / ignored → **safe** |
| New Edges + missing RPC migration | `CAPTURE_COMPOSITION_MIGRATION_REQUIRED` → **fail closed** (no fare-only capture with receivable evidence) |

---

## PG17 — both migrations + concurrency

- PostgreSQL **17.11** (Homebrew), ephemeral port 54317
- Applied `20260925120000` + `20260925130000` together
- `scripts/capture-composition-txn-concurrency-cert.sh` → **PASS** (11 races; one plan/target/key; loser adopts; no fare-only; no deadlock)

---

## Regression (all green)

| Suite | Result |
|-------|--------|
| Composition + freeze + txn-atomic | 39/39 |
| Complete 113 matrix | 113/113 |
| Cancellation/release (tripLess) | **7/7** |
| Mutex security | 9/9 |
| Stale GET-first | 7/7 |
| Historical compat | 6/6 |
| Admin capture ownership | 10/10 |
| PG17 concurrency | PASS |

---

## Deploy closure (corrected)

`submit-customer-trip-tip` **removed** from deploy set:

- Package has **no** `captureComposition*` / acquire RPC import
- PR diff vs base `a2afdea2` changes **none** of its 11 runtime files
- It only HTTP-invokes finalize; finalize deploy alone carries composition

### Exact eight Edges requiring deploy

| Slug | Live ver | Rollback = live ezbr (full) | Files | Tip package SHA-256 (full) |
|------|----------|-----------------------------|------:|----------------------------|
| finalize-trip-and-capture | 535 | `897b6306d718c70569f0e76de773abacdb557ad834330bb35f6c4d95c3712971` | 75 | `5d0fc85e1d7bbce8e36e25d34de65f9dd17f3922362cba40f7112db0bef80b90` |
| admin-capture-trip-payment | 308 | `533d7fa3a2a2cdc58667612ba8f076dda784a7346e9ba29f3e14ee1241317412` | 75 | `37a3ac3d552f683b4e0c75f5c5610a60c08ec82c022605e9074b0b33184655c9` |
| admin-remediate-trip-payment | 121 | `2cb920ad2fb919e980c75f6431c5e8a15daeac42493a57351303dc58e82beb7a` | 80 | `3c4dd8f424d93819ac51853daad93b26a9fb88eb1087a3ef3971044339db2c37` |
| capture-expired-tip-windows | 167 | `fdd70e6e405306e5de882e3b8eae801b0b1699467c4a977a350e0bd8dc6538fe` | 40 | `7e0657cddb72ff1e42689ae7ed29d860f2ea816a89d24cf8c33c3e6eb88c7023` |
| sweep-revolut-stale-holds | 176 | `a69bba897a18290aee242b0595adcddef38a567e3776e797677f2dc8f0b80e25` | 57 | `14010d965508d886630df5e4f62c77b3fb86d2316c02e9eb5fefde382ec32e99` |
| stop-workflow | 651 | `1f6b1d5f8a285991e4b105609d7436c8b6a66f7217b29e9d7ae6bed7fd54e543` | 91 | `fdae53fafeb09ba1842f8ba0d4e4ecac1d34f846c1b2ab4105ba4a1be3921c3a` |
| revolut-webhook | 297 | `b86e0d4017f48e4d1114e36eb11a5ddc0f79be36620ae13d683ecdaf3d4b01da` | 52 | `ba2dfcec116d1af23661d9cc520997f109591ee13d90d2d5337351d1713e3aef` |
| admin-hold-action | 136 | `3e72c4678e916ec7149c0fcf1e61ff3483ae8c71f0242b096f132f9296786067` | 53 | `77720748f1724bd68d4a8b51978b58baa37da8ae21622cff4c0154d8ff0d3611` |

`capture-trip-payment` — **DO NOT DEPLOY** (retired stub)  
`submit-customer-trip-tip` — **DO NOT DEPLOY** for this PR (unchanged HTTP-only package)

### Migration SHA-256

| File | SHA-256 |
|------|---------|
| `20260925120000_capture_composition_components.sql` | `323d723737c65692fb697b1e87505b19f53e71f16281fd989ad9cf607c6e28b2` |
| `rollback_20260925120000_…` | `615ccafff4769f4318d573040ffcc5b1455c24d3617a9d624da7cd3aaec9ca37` |
| `20260925130000_payment_session_acquire_capture_composition.sql` | `761c235e24fed675d994a69645bf18e7d244955ecc69b9fe6de5caca6baa6438` |
| `rollback_20260925130000_…` | `0c0d74ba682a7c8e445345280088081c7cbfda13a706ce55b18fdd503be00eef` |

---

## Migration-first deploy order (when approved)

1. Apply both forward migrations  
2. Verify RPC + service_role EXECUTE only  
3. Deploy the eight Edges above (independent packages)  
4. Never deploy capture-trip-payment or submit-customer-trip-tip for this PR

---

## Unchanged production fingerprint

OPEN 30p+6p · RESERVED/SETTLED/WAIVED 0 · MK-002 capture 500 once · TEN 425 · commission 75

FOLD_GATE_OFF · NO_MERGE · NO_MIGRATION · NO_DEPLOY · NO_LIVE_BOOK · NO_PROVIDER_MUTATION  

**STOPPED_FOR_CLEAN_ALL_GREEN_RELEASE_APPROVAL**
