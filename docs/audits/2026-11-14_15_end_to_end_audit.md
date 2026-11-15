# ONECAB final consolidated audit — 14–15 November 2026 (corrected)

**Production posture: ALL deploys PAUSED** (Edge, SQL apply, OTA, native builds, store uploads) until explicit approval.

---

## Final release pins

| Surface | Repo | Release pin | Notes |
| --- | --- | --- | --- |
| Backend (Bug #22 + CAS) | `admin-new` | **`<NEW_SHA_AFTER_PUSH>`** (must include `8b3c5c54` + CAS hardening) | Tip after this commit |
| Customer Bug #22 | `onecab-customer-native` | **`f25365ba`** | Unchanged |
| Driver multi-stop + marker | `onecab-driver-native` | **`9db6b5cc`** | Includes `b7c6e46`, `3a67fce`, `ea30ffa` |

Ancestry verified locally before push: `972956f2` ⊂ admin tip; `3a67fce`/`b7c6e46` ⊂ `9db6b5cc`; `f25365ba` = Customer tip.

---

## Issue numbering — cross-reference (do not renumber originals)

Two streams exist. This report **preserves both**.

### Stream A — Chronological Nov 13–15 workstream (prior audit #1–#22)

| Prior # | Topic | Corrected status | Production evidence |
| --- | --- | --- | --- |
| 1 | Customer OTA safe-apply | **PUBLISHED** (earlier) | Prior channel updates (session) |
| 2 | GPS freshness gate | **PUBLISHED** with location OTAs | With #3 |
| 3 | MK-261113-011 return-to-pickup / marker / live GPS | **PUBLISHED** | Driver/Customer OTAs af1f083 / f59a560 lineage |
| 4 | Go Online / Restoring soft-success | **PUBLISHED** | Driver OTA `8dea227` lineage |
| 5 | Multi-platform OTA adoption | **PUBLISHED** | MATCH telemetry in-session |
| 6–8 | Driver camera / TBT / typography | **PUBLISHED** | Android `01a1d9f0-1638…` / iOS `01a1d9f0-f8ac…` from `357053a` (~12:02–12:03Z 14 Nov); group Android `628dc687-…` / iOS `a57b0622-…` |
| 9–10 | MK-261114-002 ghost NRO | **PUBLISHED** | Android `01a1da18-f333…` / iOS `01a1da19-9c7b…` from `1f5462d` (~12:47Z) |
| 11 | Snapshot migration Option 1 HOLD | **RESOLVED → applied** (see Migration HOLD) | Corrected as `20270222250000_…` applied on prod; draft HOLD not still open |
| 12–14 | Auto-arrival + shimmer | **PUBLISHED** | Android `01a1da90-a9c2…` / iOS `01a1da91-adcf…` from `fa871a26` |
| 15 | Start Trip green | **PUBLISHED** | Android `01a1dac1-4856…` / iOS `01a1dac1-f4cc…` from `f0f7d84` |
| 16 | Customer typography (large) | **PUBLISHED** through `b0ba8e8` only | Android `01a1dc13-d78d…` group `2361c881-…` / iOS `01a1dc14-7909…` group `cd46e505-…` |
| 17 | Customer live marker visibility | **VERIFIED — DEPLOYMENT PENDING** | Tip `aea68cf`+ ⊂ tip; **OTA paused** (not published) |
| 18 | Customer typography rebalance / non-scroll | **VERIFIED — DEPLOYMENT PENDING** | Tip `c48df4d`+; **OTA paused** |
| 19 | Journey-horizon compliance | **VERIFIED — DEPLOYMENT PENDING** | Code `1f782c59`/`e0340606`; migrations not confirmed applied in this pass |
| 20 | MK-261114-006 multi-stop / post-Start floor | **VERIFIED — DEPLOYMENT PENDING** | Driver `b7c6e46` ⊂ `9db6b5cc`; **OTA paused** |
| 21 | Driver marker manoeuvre hardening | **VERIFIED — DEPLOYMENT PENDING** | `9db6b5cc`; CI `43703679296`; **OTA paused** |
| 22 | Premature Finding after scheduled cancel | **VERIFIED — DEPLOYMENT PENDING** | Backend CAS tip + Customer `f25365ba`; **not deployed** |

**Correction:** Prior report wrongly labelled #16–#18 (post-`b0ba8e8` tips) as SHIPPED. Only `b0ba8e8` typography OTA is published; marker/scroll/Bug #22 Customer tips remain **DEPLOYMENT PENDING**.

### Stream B — Parallel / omitted inventory (must not be dropped)

| ID | Item | Status | Evidence |
| --- | --- | --- | --- |
| B1 | JIT 5-minute arrival + pickup-aware fallback | **LIVE (backend)** | SSOT + Edge; first live with scheduled-dispatch v651 @ `4b437298` |
| B2 | Backend `scheduled-dispatch` **v652** | **LIVE** | `@578b75e2` (user-approved 14 Nov) |
| B3 | Driver silent GPS readiness `3a67fce` | **CI green; OTA PAUSED** | Ancestor of `9db6b5cc`; never published as standalone OTA |
| B4 | Backend `send-driver-notification` **v600** | **LIVE** | `@578b75e2` silent JIT readiness |
| B5 | Multi-stop `INTERMEDIATE_STOPS_REMAIN` `972956f2` | **CODE+CI; Edge deploy required** | Ancestor of admin tip; deploy **`stop-workflow`** |
| B6 | Driver multi-stop classification + post-Start floor | **CI; OTA PAUSED** | = Stream A #20 |
| B7 | Revolut incremental auth failures (trip mod) | **OPEN / not closed in this audit** | Locks present; no closure SHA |
| B8 | MK0006 Luton airport acceptance | **OPEN — deferred** | Explicitly kept separate all session |
| B9 | Customer Live Trip APNs + background ETA | **PARTIAL** | Implementation advanced; store packaging incomplete |
| B10 | Customer Android versionCode conflict | **PREP ADDRESSED** | Keep 1.0.6 / vc46 discipline vs Play vc45 |
| B11 | Both native welcome screens | **Customer fixed; Driver PASS** | Customer welcome `e6b25ed` lineage |
| B12 | Outstanding Google Play recommendations/errors | **OUTSTANDING** | Edge-to-edge / trader status / platform — not mid-train |

---

## Bug #22 — atomic cancellation (this correction)

### What changed after `8b3c5c54`

1. SQL RPC `release_scheduled_assignment_for_driver_cancel` — `FOR UPDATE` + CAS (`confirmed_driver_id`, `driver_id IS NULL`, `started_at IS NULL`).
2. Returns `ACTIVATED_PROTECTED` when JIT/live won → Edge returns 409 ACTIVATED (use activated cancel path).
3. Non-urgent rematch `status=scheduled` (never `offered`); urgent uses convert shape; fare/payment untouched.
4. Edge `cancel_confirmed` prefers SQL CAS; Edge CAS fallback with identical predicates if RPC absent.
5. Concurrent in-memory CAS execution tests + lock tests.

### Safeguards (post-CAS)

| # | Safeguard | Verdict |
| --- | --- | --- |
| 1 | Cancelling driver excluded | PASS (SQL `decline_scheduled_ride`) |
| 2 | Other driver can confirm Requested | PASS |
| 3 | Customer `SCHEDULED_LIST` until convert/activation | PASS (`f25365ba`) |
| 4 | Same trip / fare / payment | PASS |
| 5 | No instant waves before urgent deadline | PASS |
| 6 | Shared SSOT with compliance | PASS |
| 7 | SQL + Edge lifecycle twin | PASS |
| 8 | Concurrent JIT / Phase-5 / compliance / cancel / replace | **PASS** (SQL CAS + execution tests) |

### Local execution evidence

- `scheduledPreActivationCancelCas.execution.test.ts` — 6/6 PASS (cancel vs JIT, activate-wins, replace, double-cancel, urgent fare intact, wrong driver)
- `scheduledPreActivationReleaseSSOT.test.ts` — PASS (incl. SQL CAS lock)
- `scheduledRematchExclusionSSOT.test.ts` — PASS

### CI

Filled after push (mandatory remote CI).

---

## Migration HOLD (exact)

| Field | Value |
| --- | --- |
| Original HOLD draft | `_draft_review_only/20261114130000_driver_active_trip_snapshot_priority.sql` |
| Why held | Snapshot allowlist could surface unactivated scheduled rows with `status=accepted` |
| Corrected file | `20270222250000_driver_active_trip_snapshot_priority.sql` |
| Outcome | **Approved and applied on production** after Option 1 correction — **not still held** |
| Conflict with `20270224120000` / `20270225120000` / `20270225140000`? | **No** — snapshot priority ≠ compliance/rematch/CAS |

**Do not re-apply the draft HOLD file.** Pending scheduled migrations remain separate and unapplied until approved.

---

## Required migrations (pending approval)

1. `20270224120000_scheduled_journey_compliance_future_eligibility.sql` (if not live)
2. `20270225120000_bug22_scheduled_preactivation_release_status.sql` (compliance status=scheduled)
3. **`20270225140000_bug22_driver_cancel_preactivation_cas.sql`** (voluntary cancel CAS)

---

## Required Edge functions

| Function / module | Why |
| --- | --- |
| `scheduled-ride-action` | cancel_confirmed CAS + rematch SSOT |
| `_shared/scheduledPreActivationReleaseSSOT` | marketplace/urgent patches |
| `_shared/scheduledJourneyComplianceGate` | compliance rematch twin |
| Related compliance callers on tip | journey-horizon release |
| **`stop-workflow`** | `INTERMEDIATE_STOPS_REMAIN` from `972956f2` |
| Already LIVE (do not regress) | `scheduled-dispatch` **v652**, `send-driver-notification` **v600** |

---

## OTA targets (paused)

| App | SHA | Purpose |
| --- | --- | --- |
| Customer | **`f25365ba`** | Bug #22 presentation (+ includes paused marker/scroll ancestors) |
| Driver | **`9db6b5cc`** | Multi-stop floor + marker motion + silent GPS readiness ancestry |

Native: no rebuild required for these JS OTAs. Store uploads remain paused. Welcome/Play/versionCode items are **external / prep** blockers for store trains, not this OTA window.

---

## Remaining blockers

1. Explicit production approval (SQL → Edge → OTAs).  
2. Confirm whether `20270224120000` already live before apply.  
3. Deploy `stop-workflow` for multi-stop completion guard if not live.  
4. Stream B open items: Revolut trip-mod (#B7), MK0006 (#B8), Live Trip packaging (#B9), Play recommendations (#B12).  
5. No device/paid/historical mutations in this verification.

---

## Rollback

| Layer | Action |
| --- | --- |
| Customer OTA | Prior channel update (pre-`f25365ba`) |
| Driver OTA | Prior channel update (pre-`9db6b5cc`) |
| Edge | Prior `scheduled-ride-action` / compliance / `stop-workflow` |
| SQL CAS | `DROP FUNCTION release_scheduled_assignment_for_driver_cancel…` (rollback file) |
| SQL rematch stamp | Restore compliance function body from `20270224120000` |

---

## Final deployment order (paused)

1. SQL `20270224120000` (if needed) → `20270225120000` → **`20270225140000`**  
2. Edge from **backend release pin**: `scheduled-ride-action` + compliance modules + **`stop-workflow`**  
3. Customer OTA **`f25365ba`**  
4. Driver OTA **`9db6b5cc`**  
5. Post-deploy: voluntary pre-urgent cancel → Requested + Customer Scheduled list; activate-wins → ACTIVATED 409; cancelling driver excluded  

**Do not deploy until explicitly approved.**
