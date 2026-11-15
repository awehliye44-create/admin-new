# ONECAB final consolidated audit — 14–15 November 2026 (pre-approval)

**Production posture: ALL deploys PAUSED** (Edge, SQL apply, OTA, native builds, store uploads) until explicit approval.

Bugs **#23** (Driver Complete → Rate passenger latency) and **#24** (Customer Rate trip → Home latency) are **out of scope** for this document — deferred to a separate pass.

---

## Final release pins (preserve)

| Surface | Repo | Release pin | Notes |
| --- | --- | --- | --- |
| Backend tip | `admin-new` | **`a2018eb0`** | Docs tip; includes Edge content pin |
| Backend Edge content | `admin-new` | **`73c5e69c`** | Bug #22 SQL CAS + Edge decline-after-CAS; deploy Edge from this (or tip) when approved |
| Customer | `onecab-customer-native` | **`f25365ba`** | Bug #22 presentation + marker `23e5e34`/`fc07fd3` + scroll/type ancestors |
| Driver | `onecab-driver-native` | **`9db6b5cc`** | Multi-stop `7a2d670` + post-Start `b7c6e466` + marker + silent GPS `3a67fce` |

Ancestry (verified): `73c5e69c` ⊂ `a2018eb0`; `cd059353` / `8b3c5c54` / `972956f2` / `1f782c59` / `e0340606` / `578b75e2` ⊂ `a2018eb0`; Customer `23e5e34`+`fc07fd3` ⊂ `f25365ba`; Driver `7a2d670`+`b7c6e466`+`3a67fce` ⊂ `9db6b5cc`.

**Do not label Customer/Driver pins SHIPPED** — no production OTA publication evidence for these tips.

---

## 1. Bug #22 — full atomic CAS protection (transaction safety)

### Verdict

| Layer | Atomic vs JIT activate / Phase-5 ack arm / compliance release / replacement confirm | Status |
| --- | --- | --- |
| **SQL RPC** `release_scheduled_assignment_for_driver_cancel` (`20270225140000`) | **YES — full** | `SELECT … FOR UPDATE` serializes the trip row with peer `FOR UPDATE` writers (compliance twin, accept/confirm, ack-timeout trip-first locks). Then CAS `confirmed_driver_id = expected AND driver_id IS NULL AND started_at IS NULL`. JIT/Phase-5 that stamps `driver_id` / live status → `ACTIVATED_PROTECTED`. Replacement confirm needs cleared `confirmed_driver_id` after cancel commit. Decline runs **inside** the locked transaction after activation guards. |
| **Edge fallback** (RPC absent) | **NO — not full transaction safety** | Optimistic PostgREST CAS with identical predicates + decline **only after** CAS win (`73c5e69c`). Necessary hygiene; **does not** provide single-transaction `FOR UPDATE` serialization with compliance/JIT/Phase-5 SQL peers. |
| **In-memory CAS tests** | Predicate mutual exclusion | cancel↔JIT, activate-wins, replacement-after-cancel, double-cancel, urgent fare intact, wrong driver — **PASS**; not a substitute for live SQL apply. |

**Conclusion:** Voluntary cancel has **code-complete full atomic CAS** in migration `20270225140000` + Edge prefer-SQL path. **Production atomicity requires SQL apply** (then Edge `scheduled-ride-action` from `73c5e69c`). Until apply: **VERIFIED — DEPLOYMENT PENDING**. Decline-after-CAS alone does **not** prove complete transaction safety.

### Safeguards (post-CAS code)

| # | Safeguard | Verdict |
| --- | --- | --- |
| 1 | Cancelling driver excluded | PASS (SQL in-txn decline; Edge after CAS win) |
| 2 | Other driver can confirm Requested | PASS |
| 3 | Customer `SCHEDULED_LIST` until convert/activation | PASS (`f25365ba`) |
| 4 | Same trip / fare / payment | PASS |
| 5 | No instant waves before urgent deadline | PASS |
| 6 | Shared SSOT with compliance | PASS |
| 7 | SQL + Edge lifecycle twin | PASS |
| 8 | Concurrent JIT / Phase-5 / compliance / cancel / replace | **PASS in code** (SQL FOR UPDATE + CAS); **production pending SQL apply** |

---

## 2. Backend pin completeness (`a2018eb0` / `73c5e69c`)

Every approved backend fix for this train is an ancestor of tip **`a2018eb0`** and of Edge content **`73c5e69c`**:

| Fix | SHA | In pin? |
| --- | --- | --- |
| Silent JIT readiness push allow-list / cooldown | `578b75e2` | YES |
| `stop-workflow` empty-stops + `INTERMEDIATE_STOPS_REMAIN` | `972956f2` | YES (live **v672**) |
| Journey-horizon compliance eligibility | `1f782c59` | YES |
| Compliance migration soft-skip | `e0340606` | YES |
| Bug #22 rematch / Finding stamp | `8b3c5c54` | YES |
| Bug #22 SQL CAS migration + Edge prefer-SQL | `cd059353` | YES |
| Edge decline-after-CAS | `73c5e69c` | YES |
| Audit pin docs | `a2018eb0` | tip |

Already LIVE (do not redeploy without approval): `scheduled-dispatch` **v652**, `send-driver-notification` **v600**, `stop-workflow` **v672**.

---

## 3. Original Stream A — final 22-item status table

Numbering = chronological Nov 13–15 stream (do not renumber). **PUBLISHED** only where OTA update-group / channel evidence was recorded in-session.

| # | Issue | Status | Evidence / pin |
| --- | --- | --- | --- |
| 1 | Customer OTA safe-apply / gated reload | **PUBLISHED** | Prior channel updates; Android MATCH; iOS controlled path |
| 2 | GPS freshness gate (no invented `Date.now()` on cached GPS) | **PUBLISHED** | Shipped with location OTAs (#3) |
| 3 | MK-261113-011 return-to-pickup / marker freeze / Customer live GPS | **PUBLISHED** | Driver/Customer OTAs `af1f083` / `f59a560` lineage |
| 4 | Driver network / Restoring / Go Online soft-success | **PUBLISHED** | Driver OTA `8dea227` lineage |
| 5 | Multi-platform production OTA adoption | **PUBLISHED** | Android/iOS MATCH telemetry in-session |
| 6 | Driver active-trip camera clearance (~70dp) | **PUBLISHED** | Android `01a1d9f0-1638…` / iOS `01a1d9f0-f8ac…` from `357053a` (~12:02–12:03Z 14 Nov); groups `628dc687-…` / `a57b0622-…` |
| 7 | Driver ONECAB manoeuvre / TBT banner | **PUBLISHED** | With #6 |
| 8 | Driver active-trip typography / a11y | **PUBLISHED** | With #6 |
| 9 | MK-261114-002 scheduled ghost NRO | **PUBLISHED** | Android `01a1da18-f333…` / iOS `01a1da19-9c7b…` from `1f5462d` (~12:47Z) |
| 10 | Scheduled activation / offer paint isolation | **PUBLISHED** | With #9 |
| 11 | Snapshot migration Option 1 HOLD | **RESOLVED → applied** | `20270222250000_…` applied on prod (draft HOLD must not re-apply) |
| 12 | Driver auto-arrival @ 75 m | **PUBLISHED** | Android `01a1da90-a9c2…` / iOS `01a1da91-adcf…` from `fa871a26` |
| 13 | Auto-arrival GPS accuracy / stability review | **PUBLISHED** | With #12 |
| 14 | Pending shimmer dead `phase === 'assigned'` removal | **PUBLISHED** | With #12 |
| 15 | Start Trip button green after arrival | **PUBLISHED** | Android `01a1dac1-4856…` / iOS `01a1dac1-f4cc…` from `f0f7d84`. Post-Start demotion floor is #20 (`b7c6e466`) — **not** in this published OTA. |
| 16 | Customer active-trip card typography (large) | **PUBLISHED** through **`b0ba8e8` only** | Android `01a1dc13-d78d…` group `2361c881-…` / iOS `01a1dc14-7909…` group `cd46e505-…`. Includes touch-lock / taller layout at `b0ba8e8`. |
| 17 | Customer live driver marker visibility / overshoot | **VERIFIED — DEPLOYMENT PENDING** | `aea68cf` + raw GPS `23e5e34` + CI `fc07fd3` ⊂ `f25365ba`; compatible with `CUSTOMER_LIVE_PAIR_FRAMING`; **OTA paused** |
| 18 | Customer card scroll-only-on-overflow + typography rebalance | **VERIFIED — DEPLOYMENT PENDING** | `babb8f2f` + `c48df4d8` ⊂ `f25365ba`; **OTA paused** |
| 19 | Journey-horizon future compliance eligibility + auto assignment release | **VERIFIED — DEPLOYMENT PENDING** | `1f782c59`/`e0340606` ⊂ `73c5e69c`; migration `20270224120000_…` **not confirmed applied** |
| 20 | MK-261114-006 multi-stop sticky / post-Start floor | **VERIFIED — DEPLOYMENT PENDING (Driver OTA)** | Driver `7a2d670`+`b7c6e466` ⊂ `9db6b5cc`; backend Complete guard **LIVE** (`stop-workflow` **v672**) |
| 21 | Driver active-trip car marker / manoeuvre hardening | **VERIFIED — DEPLOYMENT PENDING** | `9db6b5cc`; CI `43703679296`; **OTA paused** |
| 22 | Premature Finding after pre-JIT scheduled cancel | **VERIFIED — DEPLOYMENT PENDING** | Backend `73c5e69c` + Customer `f25365ba`; SQL CAS **unapplied**; Edge **not redeployed** |

**PUBLISHED reconciliation:** Prior drafts wrongly labelled #17–#18 (and post-`b0ba8e8` Customer tips) as SHIPPED. Only update-groups listed above count as published. Tips `f25365ba` / `9db6b5cc` remain **DEPLOYMENT PENDING**.

---

## 4. Parallel inventory confirmations (user checklist topics)

These are **not** Stream A renumbers; mapped so nothing is dropped.

| User topic | Maps to | Status |
| --- | --- | --- |
| JIT timing + silent GPS readiness | Stream B1–B3 / backend `578b75e2` + Driver `3a67fce` | Backend **LIVE** (`scheduled-dispatch` v652, `send-driver-notification` v600). Driver silent GPS **⊂ `9db6b5cc`**, **OTA paused** (never standalone published). |
| Future scheduled compliance + automatic assignment release | Stream A #19 + Bug #22 compliance twin | Code on `73c5e69c`; migrations `20270224120000` / `20270225120000` **pending apply**. |
| Customer typography / scrolling / marker / touch·recenter | Stream A #16–#18 (+ `b0ba8e8` touch) | #16+touch **PUBLISHED** @ `b0ba8e8`. Marker (#17) + scroll/rebalance (#18) **DEPLOYMENT PENDING** on `f25365ba`. Recenter/gesture policy preserved in marker locks. |
| Live Trip APNs + background ETA | Stream B9 | **PARTIAL** — implementation advanced; store packaging incomplete |
| Incremental Revolut authorisation failures | Stream B7 | **OPEN** — locks present; no closure SHA this train |
| MK0006 Luton airport acceptance | Stream B8 | **OPEN — deferred** (kept separate all session) |
| Customer Android versionCode conflict | Stream B10 | **PREP ADDRESSED** — keep 1.0.6 / vc46 vs Play vc45 |
| Native welcome + Google Play recommendations | Stream B11–B12 | Welcome: Customer fixed (`e6b25ed` lineage), Driver PASS. Play recommendations **OUTSTANDING** (edge-to-edge / trader / platform) |

### MK-261114-006 eight-point (Driver #20) — preserved

| # | Verdict | Notes |
|---|---------|-------|
| 1 | PASS | Post-Start floor `b7c6e466` |
| 2–5 | PASS | Sticky / final-leg / Complete guard / flight lock |
| 6 | PASS | Soft/cold sticky; bare `[]` soft-preserve (`7a2d670`) |
| 7 | PASS | `via_declarations` / `stops_integrity` SSOT (no stale `total_stops`) |
| 8 | PASS | Tips `7a2d670` ⊂ `9db6b5cc`; backend **v672** LIVE — Driver OTA not SHIPPED |

---

## 5. Exact remaining blockers

1. Explicit production approval (SQL → Edge → OTAs).  
2. Confirm whether `20270224120000` already live before apply.  
3. Apply Bug #22 SQL CAS (`20270225140000`) — required for **full** cancel atomicity.  
4. Deploy Edge `scheduled-ride-action` (+ compliance shared modules) from **`73c5e69c`** (or tip `a2018eb0`).  
5. Customer OTA `f25365ba`; Driver OTA `9db6b5cc`.  
6. Open parallel: Revolut trip-mod (B7), MK0006 (B8), Live Trip packaging (B9), Play recommendations (B12).  
7. Do **not** start Bug #23 / #24 in this window.  
8. No device/paid/historical mutations in verification.

---

## 6. Required migrations (pending approval)

1. `20270224120000_scheduled_journey_compliance_future_eligibility.sql` (if not live)  
2. `20270225120000_bug22_scheduled_preactivation_release_status.sql`  
3. **`20270225140000_bug22_driver_cancel_preactivation_cas.sql`** ← full cancel `FOR UPDATE` CAS  

HOLD draft `_draft_review_only/20261114130000_…` — **do not apply**. Snapshot priority `20270222250000` already applied.

---

## 7. Required Edge deployments (pending approval)

| Function / module | Action |
| --- | --- |
| `scheduled-ride-action` | **Deploy** from `73c5e69c` (cancel CAS + decline-after-win) |
| `_shared/scheduledPreActivationReleaseSSOT` | Bundled with above |
| `_shared/scheduledJourneyComplianceGate` | Bundled / callers on tip |
| `stop-workflow` | **Already LIVE v672** — do not redeploy without approval |
| `scheduled-dispatch` | **Already LIVE v652** |
| `send-driver-notification` | **Already LIVE v600** |

---

## 8. OTA targets (paused)

| App | SHA | Includes | Status |
| --- | --- | --- | --- |
| Customer | **`f25365ba`** | Bug #22 presentation; marker `23e5e34`/`fc07fd3`; scroll/type `babb8f2f`/`c48df4d8`; touch via `b0ba8e8` ancestor | **PAUSED** |
| Driver | **`9db6b5cc`** | Multi-stop `7a2d670`; post-Start `b7c6e466`; marker motion; silent GPS `3a67fce` | **PAUSED** |

Native rebuilds / store uploads: **paused**. JS-only OTAs sufficient for these pins.

---

## 9. CI evidence

| Repo | Pin | Run |
| --- | --- | --- |
| admin-new | `cd059353` (CAS) | https://github.com/awehliye44-create/admin-new/actions/runs/43706701017 (**success**) |
| admin-new | tip `a2018eb0` | https://github.com/awehliye44-create/admin-new/actions/runs/43708166638 (**success**) — tip includes `73c5e69c` content |
| customer | `f25365ba` | https://github.com/awehliye44-create/onecab-customer-native/actions/runs/43704514348 |
| driver | `9db6b5cc` | https://github.com/awehliye44-create/onecab-driver-native/actions/runs/43703679296 |

Local reuse: Customer framing/marker 29 PASS; Driver mk261114006+multiStop 13 + stopWorkflowClient 50; Bug #22 Deno 21 PASS.

---

## 10. Final deployment order (paused)

1. SQL: `20270224120000` (if needed) → `20270225120000` → **`20270225140000`**  
2. Edge: `scheduled-ride-action` (+ compliance shared) from **`73c5e69c`** — **not** `stop-workflow`  
3. Customer OTA **`f25365ba`**  
4. Driver OTA **`9db6b5cc`**  
5. Smoke: pre-urgent cancel → Requested + Customer Scheduled list; activate-wins → ACTIVATED 409; cancelling driver excluded  

---

## 11. Rollback

| Layer | Action |
| --- | --- |
| Customer OTA | Prior channel update (pre-`f25365ba`) |
| Driver OTA | Prior channel update (pre-`9db6b5cc`) |
| Edge | Prior `scheduled-ride-action` / compliance revision |
| SQL CAS | Drop/restore `release_scheduled_assignment_for_driver_cancel` per rollback file |
| SQL rematch stamp | Restore compliance body from `20270224120000` |
| SQL #19 | `rollback/rollback_20270224120000_…` only if compliance must be withdrawn |
| `stop-workflow` | Only if a newer version were approved (v672 is current live) |

---

**Sign-off:** Original 22-item audit reconciled. Bug #22 full atomic CAS is **code-complete** pending SQL apply. Production deploys / OTA / native / store remain **PAUSED**. Bugs #23–#24 not started.
