# ONECAB consolidated production release report — 15 November 2026

**Approved workflow executed.** Native builds / TestFlight / Google Play / public store remain **paused**. Bugs #23–#24 not started. Revolut trip-mod, MK0006, Live Trip packaging, Play recommendations remain **deferred**.

---

## 1. Migrations applied

| Version | Name | Result |
| --- | --- | --- |
| `20270224120000` | `scheduled_journey_compliance_future_eligibility` | **Applied** (was not live) |
| `20270225120000` | `bug22_scheduled_preactivation_release_status` | **Applied** |
| `20270225140000` | `bug22_driver_cancel_preactivation_cas` | **Applied** |

**Procedure:** `scripts/build-guarded-migration-apply.py` + `supabase db query --linked` (no `db push`, no history repair).

**Production migration head:** `20270225140000` (`bug22_driver_cancel_preactivation_cas`).

**RPCs verified live:** `release_scheduled_assignment_for_driver_cancel`, `release_scheduled_assignment_for_compliance`, `assert_driver_scheduled_journey_compliance`, `reconcile_scheduled_journey_compliance`.

CAS markers on cancel RPC (read-only): `FOR UPDATE` ✓, `ACTIVATED_PROTECTED` ✓, `driver_id IS NULL` ✓, `started_at IS NULL` ✓, `decline_scheduled_ride` ✓.  
Compliance RPC: `FOR UPDATE` ✓, `status = 'scheduled'` ✓, no `THEN 'offered'` ✓.

---

## 2. Edge deployments

Source content pin: **`73c5e69c`** (deploy targets identical to tip at deploy time).

| Function | Version | Updated (UTC) | Action |
| --- | --- | --- | --- |
| `scheduled-ride-action` | **v591** | 2026-11-15T11:43:58Z | **Deployed** (Bug #22 CAS + decline-after-win) |
| `scheduled-dispatch` | **v653** | 2026-11-15T11:44:07Z | **Deployed** (journey-compliance gate / auto-release; was v652) |
| `admin-scheduled-ride-action` | **v11** | 2026-11-15T11:44:12Z | **Deployed** (compliance assert on admin path) |
| `stop-workflow` | **v672** | 2026-11-14T22:32:32Z | **Preserved** (not redeployed) |
| `send-driver-notification` | **v600** | 2026-11-14T22:11:14Z | **Preserved** (not redeployed) |

---

## 3. Customer production OTA

| Field | iOS | Android |
| --- | --- | --- |
| Source commit | `f25365ba` | `f25365ba` |
| Channel | `production` | `production` |
| Runtime | `1.0.6(23)` | `1.0.6(46)` |
| Update group | `940760dc-ba93-42af-831d-52d312429450` | `12de3a4d-7d5c-44dd-844d-9f67463c2cdf` |
| Update ID | `01a1df09-18b6-798b-ad1f-5e339ee91f08` | `01a1df09-18b6-7355-a2aa-520df9e6af4c` |
| Published | ~2026-11-15T11:47:58Z | ~2026-11-15T11:47:58Z |
| Message | release: Bug #22 presentation + marker overshoot + scroll/type (f25365ba) | same |

Dashboard: https://expo.dev/accounts/awehliye44/projects/onecab-customer-native/updates/940760dc-ba93-42af-831d-52d312429450

Preserved in pin: compact typography / overflow-only scroll / waiting-time panel / raw GPS overshoot + pair framing / scheduled presentation / safe OTA apply. Older `1.0.5(*)` runtimes not retargeted (current store train is `1.0.6`).

---

## 4. Driver production OTA

Published against **installed** production runtimes `1.0.6(4)` / `1.0.6(64)` (tip `app.config` is `1.0.7` for next store train — temporary runtime override for publish only; working tree restored clean).

| Field | iOS | Android |
| --- | --- | --- |
| Source commit | `9db6b5cc` | `9db6b5cc` |
| Channel | `production` | `production` |
| Runtime | `1.0.6(4)` | `1.0.6(64)` |
| Update group | `748fb13d-5f82-4497-9e32-35259e7e0636` | `8962ba52-dd1b-45f8-b771-58e72a4dcd38` |
| Update ID | `01a1df0b-c720-7223-a5e0-f661340fd8a4` | `01a1df0d-3e0e-769f-9df2-7b95a543feda` |
| Published | ~2026-11-15T11:50Z | ~2026-11-15T11:51Z |
| Message | release: multi-stop sticky + post-Start floor + marker + silent GPS (9db6b5cc) | same |

Preserved in pin: multi-stop sticky / post-Start floor / auto-arrival / road-aware marker / nav safeguards / silent JIT GPS / button colours. Safe apply (no force-offline / no active-trip interrupt).

---

## 5. Backend verification results

| Check | Result |
| --- | --- |
| Journey-horizon compliance RPCs live | **PASS** |
| Compliance release stamps `status=scheduled` (not offered) | **PASS** (SQL) |
| Cancel CAS RPC full atomic markers | **PASS** (SQL) |
| Isolated CAS: cancel↔JIT, activate-wins, replacement, fare intact | **PASS** (24 Deno tests) |
| `INTERMEDIATE_STOPS_REMAIN` | **PASS** (`stop-workflow` **v672** unchanged) |
| JIT silent readiness push path | **PASS** (`send-driver-notification` **v600** unchanged) |
| `scheduled-dispatch` post-redeploy | **v653** (compliance + prior JIT lineage retained in source) |
| No paid bookings / no historical trip mutations | **Honoured** |
| Live Trip remote fanout | **Disabled** for incomplete packaging (`customer_live_trip_settings.enabled=false`) |

---

## 6. Pin match confirmation

| Surface | Approved pin | Deployed / published |
| --- | --- | --- |
| Edge content | `73c5e69c` | Deployed (content identical) |
| Customer OTA | `f25365ba` | Published (commit on update) |
| Driver OTA | `9db6b5cc` | Published (commit on update; EAS `*` = temporary runtime patch only) |
| Migrations | three listed | Head `20270225140000` |

---

## 7. Remaining blockers / deferred

- Device/simulator adoption MATCH telemetry not collected this pass (no device testing per scope).
- Customer older `1.0.5(*)` binaries do not receive this OTA (runtime mismatch by design).
- Driver `1.0.7(*)` store binaries not yet in field; this OTA targets live `1.0.6` installs.
- **Deferred:** Revolut incremental auth failures; MK0006 Luton; Live Trip packaging (fanout off); Play recommendations.
- **Not started:** Bug #23, Bug #24.
- Native / store uploads: still paused.

---

## 8. Rollback

| Layer | Action |
| --- | --- |
| Customer OTA | `eas update:rollback` on production → prior groups `cd46e505…` / `2361c881…` (`b0ba8e8`) |
| Driver OTA | `eas update:rollback` on production → prior groups `560e53a2…` / `b09c858b…` (`f0f7d84`) |
| Edge | Redeploy prior revisions of `scheduled-ride-action` / `scheduled-dispatch` / `admin-scheduled-ride-action` |
| SQL CAS | Drop/restore `release_scheduled_assignment_for_driver_cancel` via rollback file |
| SQL rematch | Restore compliance body from pre-`20270225120000` / `20270224120000` rollback pack |
| Live Trip | Re-enable only after packaging readiness: `UPDATE customer_live_trip_settings SET enabled = true …` |
| `stop-workflow` / `send-driver-notification` | No change — leave v672 / v600 |

---

## 9. Updated original 22-item audit status

| # | Issue | Status after this release |
| --- | --- | --- |
| 1–5 | OTA safe-apply / GPS freshness / MK-261113-011 / Go Online / adoption | **PUBLISHED** (prior) |
| 6–8 | Driver camera / TBT / typography | **PUBLISHED** (prior) |
| 9–10 | Ghost NRO / offer paint | **PUBLISHED** (prior) |
| 11 | Snapshot migration HOLD | **RESOLVED → applied** (prior) |
| 12–14 | Auto-arrival + shimmer | **PUBLISHED** (prior) |
| 15 | Start Trip green | **PUBLISHED** (prior); post-Start floor now in Driver OTA #20 |
| 16 | Customer typography (`b0ba8e8`) | **PUBLISHED** (prior); superseded by today’s Customer OTA for type/scroll |
| 17 | Customer live marker / overshoot | **SHIPPED** (OTA `f25365ba` — groups above) |
| 18 | Customer scroll / typography rebalance | **SHIPPED** (OTA `f25365ba`) |
| 19 | Journey-horizon compliance + auto release | **SHIPPED** (SQL `20270224120000` + Edge `scheduled-dispatch` v653 / admin path) |
| 20 | MK-261114-006 multi-stop / post-Start | **SHIPPED** (Driver OTA `9db6b5cc`; Complete guard already LIVE v672) |
| 21 | Driver marker manoeuvre | **SHIPPED** (Driver OTA `9db6b5cc`) |
| 22 | Premature Finding after scheduled cancel | **SHIPPED** (SQL CAS + `scheduled-ride-action` v591 + Customer OTA) |

Parallel deferred (unchanged): Revolut (B7), MK0006 (B8), Live Trip packaging (B9 — fanout disabled), versionCode prep (B10), Play recommendations (B12).
