# ONECAB final consolidated audit — 14–15 November 2026 (corrected)

**Production posture: ALL deploys PAUSED** (Edge, SQL apply, OTA, native builds, store uploads) until explicit approval.

---

## Final release pins

| Surface | Repo | Release pin | Notes |
| --- | --- | --- | --- |
| Backend (Bug #22 + CAS) | `admin-new` | **`cd059353`** (+ tip docs / Edge fallback order harden) | Includes `8b3c5c54` + SQL CAS; tip may advance for docs/CAS harden only — **not Edge-deployed** |
| Customer Bug #22 + marker | `onecab-customer-native` | **`f25365ba`** | Includes `23e5e34` + `fc07fd3` (raw GPS overshoot + CI gate) |
| Driver multi-stop + marker | `onecab-driver-native` | **`9db6b5cc`** | Includes `7a2d670`, `b7c6e466`, `3a67fce`, `ea30ffa` |

Ancestry verified locally:

- Customer: `23e5e34c` ⊂ `f25365ba`; `fc07fd3c` ⊂ `f25365ba`
- Driver: `7a2d6709` ⊂ `9db6b5cc`; `b7c6e466` ⊂ `9db6b5cc`
- Backend: `972956f2` ⊂ tip; `stop-workflow` **v672 LIVE** (separate from Bug #22 Edge deploy hold)

Native Customer/Driver tips remain **DEPLOYMENT PENDING** — not SHIPPED (no production OTA publication evidence for these pins).

---

## Investigation confirmations (this pass)

| # | Check | Result |
| --- | --- | --- |
| 1 | Customer pin `f25365ba` includes marker fixes `23e5e34` + `fc07fd3` | **PASS** (ancestry) |
| 2 | Driver pin `9db6b5cc` includes `7a2d670` + post-Start floor `b7c6e466` | **PASS** (ancestry) |
| 3 | Live `stop-workflow` **v672** contains `INTERMEDIATE_STOPS_REMAIN` and rejects premature Complete before waiting/claim | **PASS** (v672 live @ prior management read; guard before finalize) |
| 4 | Customer raw GPS overshoot fallback compatible with `CUSTOMER_LIVE_PAIR_FRAMING` | **PASS** (`routeEndOvershoot` + framing lock/execution tests) |
| 5 | Relevant execution tests green | **PASS** (see Local execution evidence) |

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
| 15 | Start Trip green | **PUBLISHED** | Android `01a1dac1-4856…` / iOS `01a1dac1-f4cc…` from `f0f7d84`. **Post-Start phase floor** (delayed `arrived_at_pickup` must not demote past Start) is a later harden on Driver `b7c6e466` ⊂ `9db6b5cc` — see #20 / MK-261114-006 point 1; that tip is **not** OTA-published. |
| 16 | Customer typography (large) | **PUBLISHED** through `b0ba8e8` only | Android `01a1dc13-d78d…` group `2361c881-…` / iOS `01a1dc14-7909…` group `cd46e505-…` |
| 17 | Customer live marker visibility | **VERIFIED — DEPLOYMENT PENDING** | `aea68cf` + raw GPS overshoot `23e5e34` + CI gate `fc07fd3` ⊂ `f25365ba`; **OTA paused** (not published) |
| 18 | Customer typography rebalance / non-scroll | **VERIFIED — DEPLOYMENT PENDING** | Tip `c48df4d`+; **OTA paused** |
| 19 | Journey-horizon compliance | **VERIFIED — DEPLOYMENT PENDING** | Code `1f782c59`/`e0340606`; migrations not confirmed applied in this pass |
| 20 | MK-261114-006 multi-stop / post-Start floor | **VERIFIED — DEPLOYMENT PENDING** | Driver `7a2d670` + `b7c6e466` ⊂ `9db6b5cc`; backend guard **LIVE** via `stop-workflow` **v672**; Driver OTA **paused** |
| 21 | Driver marker manoeuvre hardening | **VERIFIED — DEPLOYMENT PENDING** | `9db6b5cc`; CI `43703679296`; **OTA paused** |
| 22 | Premature Finding after scheduled cancel | **VERIFIED — DEPLOYMENT PENDING** | Backend CAS pin + Customer `f25365ba`; SQL/Edge **not applied/redeployed** for Bug #22 |

**Correction:** Prior report wrongly labelled #16–#18 (post-`b0ba8e8` tips) as SHIPPED. Only `b0ba8e8` typography OTA is published; marker/scroll/Bug #22 Customer tips remain **DEPLOYMENT PENDING**.

### Stream B — Parallel / omitted inventory (must not be dropped)

| ID | Item | Status | Evidence |
| --- | --- | --- | --- |
| B1 | JIT 5-minute arrival + pickup-aware fallback | **LIVE (backend)** | SSOT + Edge; first live with scheduled-dispatch v651 @ `4b437298` |
| B2 | Backend `scheduled-dispatch` **v652** | **LIVE** | `@578b75e2` (user-approved 14 Nov) |
| B3 | Driver silent GPS readiness `3a67fce` | **CI green; OTA PAUSED** | Ancestor of `9db6b5cc`; never published as standalone OTA |
| B4 | Backend `send-driver-notification` **v600** | **LIVE** | `@578b75e2` silent JIT readiness |
| B5 | Multi-stop `INTERMEDIATE_STOPS_REMAIN` `972956f2` | **LIVE** | `stop-workflow` **v672** (management API version read in-session); atomic 409 before waiting finalize / complete claim |
| B6 | Driver multi-stop classification + post-Start floor | **CI; OTA PAUSED** | = Stream A #20 (`7a2d670` + `b7c6e466`) |
| B7 | Revolut incremental auth failures (trip mod) | **OPEN / not closed in this audit** | Locks present; no closure SHA |
| B8 | MK0006 Luton airport acceptance | **OPEN — deferred** | Explicitly kept separate all session |
| B9 | Customer Live Trip APNs + background ETA | **PARTIAL** | Implementation advanced; store packaging incomplete |
| B10 | Customer Android versionCode conflict | **PREP ADDRESSED** | Keep 1.0.6 / vc46 discipline vs Play vc45 |
| B11 | Both native welcome screens | **Customer fixed; Driver PASS** | Customer welcome `e6b25ed` lineage |
| B12 | Outstanding Google Play recommendations/errors | **OUTSTANDING** | Edge-to-edge / trader status / platform — not mid-train |

---

## MK-261114-006 eight-point readiness (updated)

| # | Verdict | Evidence |
|---|---------|----------|
| 1 | **PASS** (hardened) | `started_at` / local `pickedUpAtMs` win over stale pickup statuses; execution test *does not regress to at_pickup on delayed arrived_at_pickup after Start* (`b7c6e466` ⊂ `9db6b5cc`) |
| 2 | **PASS** | `resolveStickyIntermediateStops` + hydrate prefer non-empty `trip_stops` |
| 3 | **PASS** | `isOnFinalDropoffLeg` + gateway pre-check + `slideTripActionLock` |
| 4 | **PASS (LIVE)** | `stop-workflow` `INTERMEDIATE_STOPS_REMAIN` 409 before claim — **v672 live** (`972956f2` lineage) |
| 5 | **PASS** | Client flight lock + backend CAS / idempotent arrive |
| 6 | **PASS** (refined) | Soft/cold hydrate → sticky apply; bare `stops:[]` soft-preserves; flattened pickup+dropoff clears only without via signal (`7a2d670`) |
| 7 | **PASS** (refined) | Shared SSOT via `via_declarations` / `stops_integrity` (stale `total_stops` dropped); backend empty-stops skip-refresh + Complete guard |
| 8 | **PASS** (refined) | Tips: Driver `7a2d670` ⊂ `9db6b5cc` (+ `b7c6e466`, `ea30ffa`); Backend live `stop-workflow` **v672** / `972956f2`. Driver OTA **not** SHIPPED |

---

## Bug #22 — atomic cancellation (this correction)

### What changed after `8b3c5c54`

1. SQL RPC `release_scheduled_assignment_for_driver_cancel` — `FOR UPDATE` + CAS (`confirmed_driver_id`, `driver_id IS NULL`, `started_at IS NULL`).
2. Returns `ACTIVATED_PROTECTED` when JIT/live won → Edge returns 409 ACTIVATED (use activated cancel path).
3. Non-urgent rematch `status=scheduled` (never `offered`); urgent uses convert shape; fare/payment untouched.
4. Edge `cancel_confirmed` prefers SQL CAS; Edge CAS fallback with identical predicates if RPC absent.
5. Concurrent in-memory CAS execution tests + lock tests.
6. **Additional harden (code, not deployed):** Edge fallback now declines the cancelling driver **only after** CAS update wins — matches SQL order; avoids excluding a driver when activate won the race.

### Safeguards (post-CAS)

| # | Safeguard | Verdict |
| --- | --- | --- |
| 1 | Cancelling driver excluded | PASS (SQL `decline_scheduled_ride`; Edge only after CAS win) |
| 2 | Other driver can confirm Requested | PASS |
| 3 | Customer `SCHEDULED_LIST` until convert/activation | PASS (`f25365ba`) |
| 4 | Same trip / fare / payment | PASS |
| 5 | No instant waves before urgent deadline | PASS |
| 6 | Shared SSOT with compliance | PASS |
| 7 | SQL + Edge lifecycle twin | PASS (Edge decline-after-CAS aligned) |
| 8 | Concurrent JIT / Phase-5 / compliance / cancel / replace | **PASS** (SQL CAS + execution tests); production still needs SQL apply + Edge deploy |

### Local execution evidence

- Customer framing/marker: `routeEndOvershoot` + `liveDriverMarkerVisibility` + `customerMapPinFraming` — **29 PASS**
- Driver MK-261114-006: `mk261114006` + `multiStopLeg` — **13 PASS**; `stopWorkflowClient` — **50 PASS**
- Bug #22 Deno: `scheduledPreActivationCancelCas` + Release SSOT + Rematch Exclusion — **21 PASS** (incl. Edge decline-after-CAS lock)

### CI

- Prior release pin CI: https://github.com/awehliye44-create/admin-new/actions/runs/43706701017 (**success** — Build · SSOT + PostgreSQL gates @ `cd059353`)
- Customer pin CI: https://github.com/awehliye44-create/onecab-customer-native/actions/runs/43704514348
- Driver pin CI: https://github.com/awehliye44-create/onecab-driver-native/actions/runs/43703679296

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
3. **`20270225140000_bug22_driver_cancel_preactivation_cas.sql`** (voluntary cancel CAS — required for true `FOR UPDATE` atomicity)

---

## Required Edge functions

| Function / module | Why |
| --- | --- |
| `scheduled-ride-action` | cancel_confirmed CAS + rematch SSOT + decline-after-CAS Edge fallback (**deploy pending approval**) |
| `_shared/scheduledPreActivationReleaseSSOT` | marketplace/urgent patches |
| `_shared/scheduledJourneyComplianceGate` | compliance rematch twin |
| Related compliance callers on tip | journey-horizon release |
| **`stop-workflow`** | **Already LIVE v672** — `INTERMEDIATE_STOPS_REMAIN`; do **not** redeploy without approval |
| Already LIVE (do not regress) | `scheduled-dispatch` **v652**, `send-driver-notification` **v600** |

---

## OTA targets (paused)

| App | SHA | Purpose |
| --- | --- | --- |
| Customer | **`f25365ba`** | Bug #22 presentation + marker overshoot (`23e5e34`/`fc07fd3`) + paused scroll ancestors |
| Driver | **`9db6b5cc`** | Multi-stop sticky (`7a2d670`) + post-Start floor (`b7c6e466`) + marker motion + silent GPS readiness |

Native: no rebuild required for these JS OTAs. Store uploads remain paused. Welcome/Play/versionCode items are **external / prep** blockers for store trains, not this OTA window.

**Do not label these OTAs SHIPPED** until production channel publication evidence exists.

---

## Remaining blockers

1. Explicit production approval (SQL → Edge `scheduled-ride-action` → OTAs).  
2. Confirm whether `20270224120000` already live before apply.  
3. ~~Deploy `stop-workflow`~~ — **done (v672 LIVE)**; no further stop-workflow deploy without approval.  
4. Stream B open items: Revolut trip-mod (#B7), MK0006 (#B8), Live Trip packaging (#B9), Play recommendations (#B12).  
5. No device/paid/historical mutations in this verification.

---

## Rollback

| Layer | Action |
| --- | --- |
| Customer OTA | Prior channel update (pre-`f25365ba`) |
| Driver OTA | Prior channel update (pre-`9db6b5cc`) |
| Edge | Prior `scheduled-ride-action` / compliance; `stop-workflow` only if a newer version were approved |
| SQL CAS | `DROP FUNCTION release_scheduled_assignment_for_driver_cancel…` (rollback file) |
| SQL rematch stamp | Restore compliance function body from `20270224120000` |

---

## Final deployment order (paused)

1. SQL `20270224120000` (if needed) → `20270225120000` → **`20270225140000`**  
2. Edge from **backend tip**: `scheduled-ride-action` + compliance modules (**not** `stop-workflow` — already v672)  
3. Customer OTA **`f25365ba`**  
4. Driver OTA **`9db6b5cc`**  
5. Post-deploy: voluntary pre-urgent cancel → Requested + Customer Scheduled list; activate-wins → ACTIVATED 409; cancelling driver excluded  

**Do not deploy until explicitly approved.** OTA, native builds, and store uploads remain paused.
