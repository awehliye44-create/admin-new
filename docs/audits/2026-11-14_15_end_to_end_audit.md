# ONECAB consolidated end-to-end audit — 14–15 November 2026

**Release posture:** all production deployments, OTA publishing, native builds and store uploads remain **PAUSED** until explicitly approved.

**Release pins (do not substitute):**

| Surface | Repo | Release SHA | Tip (docs may advance) |
| --- | --- | --- | --- |
| Backend Bug #22 + compliance | `admin-new` | **`8b3c5c54`** | `55de40c6` (docs only) |
| Customer Bug #22 presentation | `onecab-customer-native` | **`f25365ba`** | `f25365ba` |
| Driver marker / MK-261114-006 | `onecab-driver-native` | **`9db6b5cc`** | `9db6b5cc` |

---

## Executive summary

Twenty-two tracked issues from the 14–15 November booking / Driver / Customer / scheduled-lifecycle audit stream. **Bug #22** is now **VERIFIED — DEPLOYMENT PENDING** after code-level approval and eight-point safeguard confirmation (evidence below). No production apply has been performed.

---

## Bug #22 — Premature Instant Rematching After Scheduled Confirmation Cancellation

**Status: VERIFIED — DEPLOYMENT PENDING**

**Incident:** `MK-261115-004` (UUID: look up production `trips.trip_code` read-only; no historical mutations).  
**Classification:** **C** (backend rematch stamp + wrong convert clock; Customer Finding over-match).  
**Release pins:** backend `8b3c5c54`, Customer `f25365ba`.

### Pre-deploy safeguard confirmation

| # | Safeguard | Verdict | Evidence (reuse — no re-test run required) |
| --- | --- | --- | --- |
| 1 | Cancelling driver excluded from reconfirm | **PASS** | `cancel_confirmed` + compliance call `decline_scheduled_ride` before rematch; lock `scheduledRematchExclusionSSOT.test.ts` |
| 2 | Another eligible driver can confirm from Requested | **PASS** | Marketplace rematch: `status=scheduled`, `dispatch_mode=scheduled`, `scheduled_status=broadcasting`, `dispatch_status=available`, assignment cleared — Make Available shape; pre-window kicks `scheduled-dispatch` only |
| 3 | Customer stays on `SCHEDULED_LIST` until genuine activation/convert | **PASS** | `resolveCustomerTripPresentation` Bug #22 case; marketplace `broadcasting` / legacy `offered` not activated; convert/`searching*` still Finding |
| 4 | Original booking ID, fare, payment authorisation unchanged | **PASS** | Rematch patches clear assignment/JIT only; no fare/payment columns; same `trip_id`; `cancelled_at: null` (not terminal cancel) |
| 5 | No instant dispatch waves before unclaimed conversion deadline | **PASS** | Convert + `auto-dispatch` only when `shouldUrgentConvertOnPreActivationRelease` (urgentTrigger ~9m); pre-urgent uses `scheduled-dispatch` marketplace sweep |
| 6 | Voluntary cancel + compliance release share lifecycle SSOT | **PASS** | Both use `buildScheduledMarketplaceRematchPatch` / urgent rematch from `scheduledPreActivationReleaseSSOT`; urgent clock = `shouldUseUrgentRescueForComplianceRelease` |
| 7 | SQL migration + Edge identical lifecycle decisions | **PASS** | `20270225120000_…` non-urgent `status='scheduled'`; urgent `converted_to_instant`/`searching`; Edge marketplace SSOT + Broadcast Now twin; lock asserts no `THEN 'offered'` |
| 8 | Concurrent JIT activation + assignment release safely protected | **PASS*** | SQL/Edge compliance: CAS `confirmed_driver_id` + `driver_id IS NULL` + `started_at IS NULL`. Voluntary cancel: ownership check + rejects `en_route`/`arrived`/`in_progress`. *Residual: Edge cancel update is trip-id scoped after preflight (not full SQL CAS); live statuses still blocked. Acceptable for deploy pending; optional CAS harden post-release. |

### CI (Bug #22)

| Repo | SHA | Run | Result |
| --- | --- | --- | --- |
| admin-new | `8b3c5c54` | https://github.com/awehliye44-create/admin-new/actions/runs/43704514827 | success |
| customer | `f25365ba` | https://github.com/awehliye44-create/onecab-customer-native/actions/runs/43704514348 | success |

### Execution-test evidence (Bug #22)

- Deno `scheduledPreActivationReleaseSSOT.test.ts` — urgent clock ≠ check-in; marketplace never `status=offered`; urgent convert shape; cancel/compliance/SQL locks
- Deno rematch exclusion + phase-2 cancel locks (updated for SSOT)
- Jest `resolveCustomerTripPresentation.test.ts` — MK-261115-004 shape → `SCHEDULED_LIST`; convert/`searching*` Finding preserved

### Bug #22 deployment package (paused)

1. Migration `20270225120000_bug22_scheduled_preactivation_release_status.sql`
2. Edge: `scheduled-ride-action` + `_shared/scheduledPreActivationReleaseSSOT` + `_shared/scheduledJourneyComplianceGate` (+ shared deps already on tip)
3. Customer OTA from **`f25365ba`**
4. Related prior (if not already live): journey compliance migration `20270224120000_…` + Edge wiring at `1f782c59`/`e0340606` ancestors of `8b3c5c54`

### Rollback (Bug #22)

1. Customer: prior OTA / revert presentation commit  
2. Edge: previous `scheduled-ride-action` / compliance gate  
3. SQL: restore `release_scheduled_assignment_for_compliance` from `20270224120000_…`

---

## Issues #1–#21 (14–15 November tracked stream)

Numbering follows the chronological audit/implement stream that Bug #22 was appended to. Statuses reflect code + CI evidence already collected in-session; production apply may still be pending where noted.

| # | Issue | Key refs | Surface | Status | Release / tip SHA | CI / notes |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Customer OTA safe-apply / gated reload | Customer OTA | Customer | **SHIPPED** (prior OTA) | session OTA tips | Adoption MATCH on Android; iOS recovered via controlled path |
| 2 | GPS freshness gate — no invented `Date.now()` freshness on cached GPS | freshness | Driver + Customer | **VERIFIED / shipped with location OTAs** | with #3 | Gate required before OTA publish |
| 3 | MK-261113-011 return-to-pickup after Arrived; independent marker freeze; Customer live GPS | MK-261113-011 | Driver + Customer | **SHIPPED** | Driver/Customer location OTAs | Mandatory CI patterns in both apps |
| 4 | Driver network / Restoring / Go Online soft-success | Go Online | Driver | **SHIPPED** | tip incl. soft-success fix | CI green in-session |
| 5 | Multi-platform production OTA adoption verification | OTA adoption | Driver + Customer | **SHIPPED** | Android/iOS MATCH verified | Motorola/online caveats noted historically |
| 6 | Driver active-trip camera clearance (~70dp above card) | nav camera | Driver | **SHIPPED** | `357053a` lineage | OTA published + MATCH |
| 7 | Driver ONECAB manoeuvre / turn-by-turn banner | TBT banner | Driver | **SHIPPED** | with #6 | No waiting/fare/dispatch policy change |
| 8 | Driver active-trip typography / a11y | a11y | Driver | **SHIPPED** | with #6 | Larger shared typography |
| 9 | MK-261114-002 scheduled ghost NRO (£0 / 0s Accept) | MK-261114-002 | Driver | **VERIFIED — client safeguards shipped** | Driver OTA after ghost fix | Prod RCA: confirmed future booking; empty `ride_offers` at query; presentation SSOT |
| 10 | Scheduled activation / offer paint isolation (ghost class) | offer paint SSOT | Driver | **VERIFIED** | with #9 | Preserve nav/OTA; no force restart |
| 11 | Migration verification + Option 1 HOLD on production migration apply | migrations | admin-new | **HOLD preserved** | n/a | Explicit: do not apply held migration until approved |
| 12 | Driver auto-arrival (pickup + intermediate) @ 75 m | auto-arrival | Driver | **SHIPPED** | `fa871a26` OTA lineage | Manual Arrived + 150 m waiting unchanged |
| 13 | Auto-arrival GPS accuracy / stability safeguard review | GPS safeguards | Driver | **VERIFIED** | with #12 | Pre-commit review accepted |
| 14 | Pending shimmer dead `phase === 'assigned'` removal | shimmer | Driver | **SHIPPED** | with #12 | Shimmer retained for real arrive paths |
| 15 | Start Trip button green after arrival | UI | Driver | **SHIPPED** | Driver tip lineage | Visual distinctness only |
| 16 | Customer active-trip card typography | typography | Customer | **SHIPPED** | Customer OTA after typography | Later correction applied (#18) |
| 17 | Customer live driver marker visibility / overshoot framing | marker visibility | Customer | **SHIPPED** | Customer tip + CI patterns | Hysteresis; preserve gestures/recenter |
| 18 | Customer remove unnecessary active-trip card scrolling + typography correction | card scroll | Customer | **SHIPPED** | Customer tip | Non-scroll unless genuine overflow |
| 19 | Scheduled booking future compliance eligibility (journey-horizon docs) | compliance | admin-new | **VERIFIED — DEPLOYMENT PENDING** | `1f782c59` + soft-skip `e0340606` ⊂ `8b3c5c54` | CI https://github.com/awehliye44-create/admin-new/actions/runs/43700214104 ; migration `20270224120000_…` |
| 20 | MK-261114-006 multi-stop sticky vias / post-Start → at_pickup demotion | MK-261114-006 | Driver | **VERIFIED — DEPLOYMENT PENDING (OTA)** | `b7c6e46` ⊂ `9db6b5cc` | Post-Start floor locked; device OTA paused |
| 21 | Driver active-trip car marker along-route / manoeuvre hardening | marker motion | Driver | **VERIFIED — DEPLOYMENT PENDING (OTA)** | **`9db6b5cc`** | CI https://github.com/awehliye44-create/onecab-driver-native/actions/runs/43703679296 |
| 22 | Premature Finding after pre-JIT scheduled cancel | MK-261115-004 | admin-new + Customer | **VERIFIED — DEPLOYMENT PENDING** | **`8b3c5c54`** + **`f25365ba`** | See full section above |

---

## Final repository SHAs (consolidated)

| Repo | Branch | Release pin | Current tip | Notes |
| --- | --- | --- | --- | --- |
| admin-new | `main` | **`8b3c5c54`** | `55de40c6` | Tip = docs audit SHA record only; **deploy Bug #22 from `8b3c5c54`** |
| onecab-customer-native | `master` | **`f25365ba`** | `f25365ba` | Bug #22 presentation |
| onecab-driver-native | `master` | **`9db6b5cc`** | `9db6b5cc` | Marker + MK-261114-006 |

---

## Remaining blockers

1. **Explicit production approval** still required (Edge / SQL / OTA / native / store).  
2. **Bug #22 live rematch verification** after deploy (no device/paid booking in this verification pass).  
3. **Bug #19** journey-compliance migration + Edge must be live (or applied in same window) before / with Bug #22 compliance twin.  
4. **Bugs #20–#21** Driver OTA still paused.  
5. **Bug #11** migration HOLD — do not apply held migrations.  
6. **Bug #22 #8 residual** — optional Edge cancel CAS harden (non-blocking).  
7. **MK-261115-004 UUID** — read-only prod lookup for ops timeline completeness (no mutation).

---

## Exact deployment dependencies & recommended order

**Still paused — execute only after explicit approval.**

### Order A — Backend scheduled lifecycle (Bugs #19 + #22)

1. Confirm ancestors: `e0340606` / `1f782c59` present under `8b3c5c54`.  
2. Apply SQL: `20270224120000_scheduled_journey_compliance_future_eligibility.sql` (if not live).  
3. Apply SQL: **`20270225120000_bug22_scheduled_preactivation_release_status.sql`**.  
4. Deploy Edge from **`8b3c5c54`**:  
   - `scheduled-ride-action`  
   - modules used by `scheduledJourneyComplianceGate` / `scheduledPreActivationReleaseSSOT`  
   - related compliance callers already on that tip  
5. Smoke (ops): cancel pre-urgent confirmed scheduled → Requested marketplace; Customer Scheduled list; no Finding; cancelling driver excluded.

### Order B — Customer OTA (Bug #22)

6. Publish Customer production OTA from **`f25365ba`** (presentation guard).  
7. Verify adoption MATCH on target devices (when approved).

### Order C — Driver OTA (Bugs #20–#21; independent of #22)

8. Publish Driver production OTA from **`9db6b5cc`** (multi-stop floor + marker motion).  
9. Verify adoption MATCH.

### Do not in this window

- Native rebuilds / store uploads unless separately approved  
- Historical trip mutations / paid test bookings  
- Competing scheduled-release implementations  
- Softening lock tests  

---

## Rollback (consolidated)

| Layer | Action |
| --- | --- |
| Customer OTA | Roll to prior channel update (pre-`f25365ba`) |
| Driver OTA | Roll to prior channel update (pre-`9db6b5cc`) |
| Edge | Redeploy prior `scheduled-ride-action` / compliance gate revision |
| SQL Bug #22 | Restore `release_scheduled_assignment_for_compliance` from `20270224120000_…` |
| SQL Bug #19 | Use `rollback/rollback_20270224120000_…` only if compliance must be fully withdrawn |

---

## Sign-off

- Bug #22 code: **approved**  
- Bug #22 eight safeguards: **confirmed** (residual CAS note on voluntary Edge cancel documented)  
- Bug #22 status: **VERIFIED — DEPLOYMENT PENDING**  
- Production deploys / OTA / native / store: **PAUSED** until explicit approval  
