# PR #80 — Final Capture Composition SSOT Release Gate (READ-ONLY)

**Frozen tip:** `160cd64aca17c30975840eb81dfdf0f77cf3b581` (includes this gate doc)  
**Code tip (composition SSOT):** `1cbd29e7f0834a1af7ea5a8d8fcd18b4c7f9ff53`  
**PR:** https://github.com/awehliye44-create/admin-new/pull/80 (draft)  
**Base:** `financial-main`  
**Gate:** `STOPPED_FOR_FINAL_CAPTURE_SSOT_RELEASE_APPROVAL`

No merge / migration / deploy / Book / provider mutation in this package.

Classification: **C** (+ **B**). Not A / not D.

---

## PHASE 1 — Plan persistence & concurrency

| Requirement | Status | Evidence |
|-------------|--------|----------|
| Same-session RESERVED read for plan | **PARTIAL** | `loadPlanAndPersistCaptureComposition` reads `payment_session_receivable_allocations` where `status=RESERVED` |
| Under canonical financial lock | **GAP** | Plan load+persist runs **before** `claimPaymentSessionFinancialLock(..., CAPTURING)` in `revolutCompletionCapture` |
| Persist before provider POST | **PASS** | `loadPlanAndPersistCaptureComposition` then later `captureRevolutOrder` |
| Plan immutable after submission begins | **GAP** | No write-once / freeze; re-entry can rewrite composition columns/metadata |
| Concurrent Skip/submit/expiry/admin → one plan | **PARTIAL** | Tip-window mutex + financial lock serialize **POST**; plan stamp itself is not lock-ordered |
| One active capture plan per session/order | **PARTIAL** | Unique index on `capture_idempotency_key`; columns are single-row but can be overwritten |
| Duplicate execution reconciles existing plan | **GAP** | No resume-from-frozen-plan; recomputes each call |
| Idempotency key from frozen target | **PASS** | `capture_composition:v1:{session}:{order}:{target}` |
| Crash after persist / before POST → resume | **GAP** | No dedicated resume path; relies on re-plan |
| Crash after POST / before local persist → GET-first | **PASS (existing)** | Already-captured / retrieve paths in completion + admin capture |
| UNKNOWN retains plan + RESERVED, no new POST | **PASS (planner)** | Settlement planner retains; tip-window/completion refuse capture on unknown states |

**Release implication:** concurrency/immutability gaps are **blocking** for unconditional approval. Recommend a follow-up commit that: (1) claims financial lock **before** RESERVED read + plan persist, (2) freezes plan once `CAPTURING` / key set, (3) resumes frozen plan on retry, (4) fails closed if RESERVED exist and session/plan missing.

**Historical fail-closed (related):** if `compositionSessionId` is empty, completion still falls back to fare+tip (`farePlusTipPence`) — **not** fail-closed when RESERVED exist without a session. Must harden before fold-on / live fold bookings.

---

## PHASE 2 — Migration security & compatibility

| Item | Value |
|------|--------|
| Forward | `supabase/migrations/20261130120000_capture_composition_components.sql` |
| Rollback | `supabase/migrations/rollback/rollback_20261130120000_capture_composition_components.sql` |
| Forward SHA-256 | `a405614b5ea752ce0c6291dc97826294eefa1c0b4bd011458a756cbc354c49f4` |
| Rollback SHA-256 | `c9942206b34199618d76c9ee024be8071a23ce38f9bf13f0ef8b487294510f4a` |

**Tables/columns:** `payment_sessions` adds nullable:
`trip_fare_component_pence`, `tip_component_pence`, `receivable_component_pence`, `provider_capture_target_pence`, `capture_composition_version`, `capture_idempotency_key`

**Index:** unique partial `payment_sessions_capture_idempotency_key_uidx` WHERE key IS NOT NULL

| Control | Present in this migration? |
|---------|----------------------------|
| Integer-pence / non-negative CHECKs | **NO — GAP** |
| Component-sum invariant CHECK | **NO — GAP** |
| Service-role grants (new objects) | N/A (columns only; table grants inherit) |
| Anon/authenticated mutation denial | **NO new policies** — relies on existing `payment_sessions` RLS |
| Locked `search_path` | **N/A** (no new RPC) |
| Append-only capture evidence table | **NO — GAP** (columns overwriteable) |
| New RPCs | **None** |

**Historical sessions:** columns NULL — no invented receivable components.  
**Old Edge during migration-first:** old code ignores new columns (safe). New Edge before migration: writes to missing columns fail → capture abort (fail closed for persistence; verify ops ordering).  
**RESERVED without plan:** **must fail closed** — currently incomplete (see Phase 1).

---

## PHASE 3 — Deploy closure (independent Edge packages)

Built with `scripts/step82b31-closure-builder.ts` at tip `1cbd29e7` → `/tmp/pr80-closures-final`.

| Edge slug | Role | Bundles captureComposition? | Files | Package tree SHA-256 |
|-----------|------|-------------------------------|------:|----------------------|
| `finalize-trip-and-capture` | **Deploy** — direct `finalizeRevolutTripCapture` → completion capture + plan | YES (2) | 74 | `c557f2601f7251e15157fab81fd72d289e3dc58045152c2765299a1d73229f2c` |
| `capture-expired-tip-windows` | **Deploy** — HTTP `invokeFinalize` + static planner import | YES (1) | 40 | `3ba8940b3f7ae01f5b10d7acc6bf55fe544c317d133b6a6578beb4fc64fa86d6` |
| `submit-customer-trip-tip` | **Deploy** — HTTP `invokeFinalize` only | NO | 11 | `ca73cfc19e7bf50f504007a9c1da7037165e601598f31e2c1bd5b75ad2cfac1f` |
| `capture-trip-payment` | **Retired stub** — blocks to finalize | NO | 5 | `2db3a848c4057d06448b5eee7df508f154a1dee3080b1c13b69d1c0e946e8cee` |
| `admin-capture-trip-payment` | **Deploy** — `adminCaptureTripPaymentSSOT` + plan | YES (2) | 74 | `07981d5b9ae84bf480015ac45f62563a73050de09a7ac1e703aef25e602fe411` |
| `admin-remediate-trip-payment` | **Deploy** — `finalizeRevolutTripCapture` | YES (2) | 79 | `58bc48da95919158b0cbb6352b50c117a2f245803ec793d0b63bf0fb8746b4e4` |
| `admin-hold-action` | **Deploy** — `paymentSessionSSOT` (settlement gate on capture marks) | YES (1) | 53 | `5972c38940c3182c3c923dc65fdd87950321ca801afd995852606b387f37434d` |
| `sweep-revolut-stale-holds` | **Deploy** — HTTP finalize + planner import | YES (1) | 57 | `212abb15f8e6011330496134cf3d7e943ef487f90b64601b8c536bc608bc4086` |
| `stop-workflow` | **Deploy** — HTTP `invokeFinalize` (tip window open path) | YES (1)* | 91 | `c7bd357497f84566b4f9a4da1f9292c3d1e055783c8fd3709e46cb2530515a4c` |
| `revolut-webhook` | **Deploy** — reconcile/persist (settlement via `persistConfirmed` → `markPaymentSessionCaptured`) | YES (1) | 52 | `d12b0edd448a035cf046c9e3770a453e84bbdb50e2b904058fa9cf8291a0a30c` |

\*stop-workflow / webhook may pull composition via shared settlement graph; capture POST still owned by finalize/admin packages.

**Do not claim one deployed bundle updates another.** Redeploy each slug independently after migration.

**Live version / rollback version:** **UNKNOWN** this environment (`supabase link` missing). Fill from production before deploy.

**Minimum deploy set after migration:**  
`finalize-trip-and-capture`, `admin-capture-trip-payment`, `admin-remediate-trip-payment`, `capture-expired-tip-windows`, `submit-customer-trip-tip`, `sweep-revolut-stale-holds`, `stop-workflow`, `revolut-webhook`, `admin-hold-action`.

---

## PHASE 4 — Lock matrix (executed at tip)

| Suite | Result |
|-------|--------|
| Capture composition (`captureCompositionSSOTLock`) | **20/20 PASS** |
| Tip-window state machine | **15/15 PASS** |
| Tip-window early capture | **8/8 PASS** |
| Terminal dispose receivable release | **13/13 PASS** |
| Receivable lifecycle | **35 PASS** (file suite) |
| Receivable concurrency | **3/3 PASS** |
| Policy A isolation | **3/3 PASS** |
| Consent / fold gate | **11/11 PASS** (gate default OFF) |
| Corporate/guest isolation | **5/5 PASS** |
| Tip-window mutex RPC security | **9/9 PASS** (`--no-check`) |
| Expired tip stale GET-first reclaim | **7/7 PASS** (`--no-check`) |
| Admin capture ownership | **NOT RE-RUN** (npm typecheck env); ownership locks exist on branch |
| Historical compatibility (composition) | **PARTIAL** — planner tests pass; Edge fail-closed for RESERVED∖plan **GAP** |
| Edge import-closure | Closures built unresolved=0 for all listed slugs |
| Combined pure matrix (composition+tip SM+early+dispose+recv lifecycle/concurrency/PolicyA/consent/corp) | **113/113 PASS** |

**Explicit formula proofs (locks 1,3,4,7,8,9,12,16,17):**

- 500+36+0 buffer → capture **536**
- 500+36+300 buffer → capture **536** / release **300**
- tip 100 → capture **636**
- tip decline → zero fare capture (orchestration + completion source)
- planned recv=0 & captured=500 → settle **0** / release receivables
- planned recv=36 & captured=536 → settle **36** once
- UNKNOWN → no settle/release/new POST (planner)
- receivable ≠ TEN/commission in planner components

---

## PHASE 5 — Reader / UI consequences

Successful **future** settlement (`customer_receivable_settle_from_provider_capture`) sets receivable `SETTLED` + append-only events.

| Surface | Auto-update? | Reader |
|---------|--------------|--------|
| Customer Receivables admin page | **YES** (live DB status) | `src/pages/CustomerReceivables.tsx` reads `customer_receivables.status` |
| Customer Rides MK-012/MK-017 outstanding | **YES** if rides UI reads receivable outstanding / trip outstanding fields | No rewrite of historical provider capture amounts |
| FR `CUSTOMER_OUTSTANDING` | **YES** when `receivable_outstanding_pence` → 0 | `frCustomerOutstandingSSOT.ts` → overview tab |
| Driver Wallet | **NO debt-derived open difference** | Policy A locks; settle path does not credit TEN/commission |

**MK-012 / MK-017 today:** remain **OPEN** (36p total) until a **future** booking captures with planned receivable component — **no** settlement from MK-260925-002 (planned component was effectively 0 / fare-only capture). No separate UI PR required for SSOT readers.

---

## PHASE 6 — Release report

### Changed files (a2afdea2...1cbd29e7)

```
.cursor/rules/capture-composition-ssot-lock.mdc
docs/CAPTURE_COMPOSITION_SSOT_RELEASE_PREP.md
supabase/functions/_shared/adminCaptureTripPaymentSSOT.ts
supabase/functions/_shared/captureCompositionLoadPlan.ts
supabase/functions/_shared/captureCompositionSSOT.ts
supabase/functions/_shared/paymentSessionSSOT.ts
supabase/functions/_shared/revolutCompletionCapture.ts
supabase/functions/_shared/tipWindowCaptureOrchestrationSSOT.ts
supabase/functions/admin-capture-trip-payment/index.ts
supabase/functions/capture-expired-tip-windows/index.ts
supabase/functions/sweep-revolut-stale-holds/index.ts
supabase/migrations/20261130120000_capture_composition_components.sql
supabase/migrations/rollback/rollback_20261130120000_capture_composition_components.sql
supabase/tests/_shared/captureCompositionSSOTLock.test.ts
```

### Rollback procedure

1. Do **not** deploy Edge until migration applied (or roll Edge back first).
2. Redeploy previous Edge package SHAs from prior financial-main tip `a2afdea2`.
3. Apply rollback SQL `rollback_20261130120000_capture_composition_components.sql`.
4. Confirm columns dropped; receivables untouched.
5. Fold remains OFF.

### Zero-money verification plan (post-approval only)

1. Staging session: RESERVED 36 + buffer 0 + auth 536 → persist plan target 536 → no POST yet.
2. Capture → GET COMPLETED 536 → settle 36 once; OPEN=0.
3. Parallel: buffer 300 case → capture 536, unused buffer 300.
4. Tip decline → zero capture calls.
5. Incident remediations unchanged: MK-002 no second capture; OPEN 36 preserved until future book.
6. TEN/commission/wallet unchanged on receivable settle.

### Current production fingerprint (confirmed financial truth — no new mutation)

- MK-012 **OPEN 30p**
- MK-017 **OPEN 6p**
- RESERVED / SETTLED / WAIVED **0** (for these after Phase-2 release)
- MK-260925-002 captured **500p once**
- TEN **425p** / commission **75p**
- No new provider / wallet / payout mutation in this gate

### Gates

- `CUSTOMER_RECEIVABLE_FOLD_ENABLED=false`
- 3DS / hosted-checkout auto-close **out of PR #80**

### Blocking before unconditional release approval

1. Financial-lock-before-plan + immutable frozen plan + resume
2. Fail closed when RESERVED exist without safe composition plan/session
3. Migration CHECKs (non-negative, optional sum invariant) and/or append-only evidence
4. Fill live Edge version table from production
5. Re-run npm-dependent tip mutex / stale reclaim locks in linked CI

---

**STOPPED_FOR_FINAL_CAPTURE_SSOT_RELEASE_APPROVAL**
