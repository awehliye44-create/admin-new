# Bugs #23 / #24 — Production performance release report

**Date:** 2026-11-15  
**Status:** **SHIPPED** (Edge + Customer OTA). Native / store / Driver OTA **not** changed.  
**Device performance targets:** **not claimed** — awaiting personal device measurement.

---

## 1. Baseline preserved

| Pin | Value | Status |
| --- | --- | --- |
| Migration head | `20270225140000` | Unchanged (no migrations) |
| Prior Customer OTA | `f25365ba` | Superseded by this release |
| Driver OTA | `9db6b5cc` | Unchanged (no Driver OTA) |
| Prior `stop-workflow` | v672 | Superseded → **v673** |
| `scheduled-ride-action` | v591 | Preserved |
| `scheduled-dispatch` | v653 | Preserved |
| `admin-scheduled-ride-action` | v11 | Preserved |
| `send-driver-notification` | v600 | Preserved |

---

## 2. Final source SHAs

| Surface | SHA | Ancestry |
| --- | --- | --- |
| **Backend deploy source** | `718eb907738d2f8c06d669c46718e8dee254f93b` | Contains `ceceb1f1` ⊂ `d1978629` ⊂ `20a9d2ea` ⊂ tip (+ tip Edge `b1a947f1`) |
| **Customer OTA source** | `194a3a51ffe21f9a4b3cebffa2862459fe9fcb1d` | Contains `b8018b3` ⊂ `b3f2f3f` ⊂ `194a3a5` |
| Driver | `03a31b9` test-only | **No OTA** |

---

## 3. Edge deployments

| Function | Version | Updated (UTC) | Action |
| --- | --- | --- | --- |
| `stop-workflow` | **v673** | 2026-11-15T13:17:23Z | **Deployed** — capture deferral, CAPTURE_QUEUE_FAILED, idempotent recover |
| `submit-customer-trip-tip` | **v92** | 2026-11-15T13:17:27Z | **Deployed** — durable tip accept + background finalize |
| Shared deps | bundled via `--use-api` | — | No separate function deploys |
| `finalize-trip-and-capture` | v554 | unchanged | Reused SSOT |
| `capture-expired-tip-windows` | v178 | unchanged | Tip/fare recovery after window |
| `sweep-revolut-stale-holds` | v192 | unchanged | `capture_requested` / AUTHORISED completed retry |

Project: `thazislrdkjpvvghtvzo`

---

## 4. Customer production OTA

| Field | iOS | Android |
| --- | --- | --- |
| Source commit | `194a3a5` | `194a3a5` |
| Channel | `production` | `production` |
| Runtime | `1.0.6(23)` | `1.0.6(46)` |
| Update group | `a706001e-e5df-45b7-8287-17d76d3b357d` | `808a2212-5720-4fda-a5a9-e89cbed91729` |
| Update ID | `01a1df5b-f83e-7501-8912-a1d27f924418` | `01a1df5c-91e5-7a59-9101-bb560e5fbf7e` |
| Message | release: Bugs #23/#24 rating Home + durable tip accept (194a3a5) | same |

Dashboards:  
- iOS: https://expo.dev/accounts/awehliye44/projects/onecab-customer-native/updates/a706001e-e5df-45b7-8287-17d76d3b357d  
- Android: https://expo.dev/accounts/awehliye44/projects/onecab-customer-native/updates/808a2212-5720-4fda-a5a9-e89cbed91729  

OTA safe-apply protection preserved (no force offline / no active-trip interrupt changes).

---

## 5. Production verification

| Check | Result |
| --- | --- |
| SHA ancestry (backend + Customer) | **PASS** |
| No unexpected migrations | **PASS** (head still `20270225140000`) |
| `stop-workflow` v673 live | **PASS** |
| `submit-customer-trip-tip` v92 live | **PASS** |
| Prior scheduled Edge pins preserved | **PASS** (v591 / v653 / v11 / v600) |
| CAPTURE_QUEUE_FAILED + idempotent recover in source | **PASS** |
| Tip durable accept + `scheduleEdgeBackground` | **PASS** |
| `INTERMEDIATE_STOPS_REMAIN` | **PASS** |
| Driver OTA skipped | **PASS** |
| Bug #25 (separate) | **FIXED in Customer tip** (OTA paused) — see `2026-11-15_bug25_trip_mod_payment_decline_recovery.md` |
| Device timing targets achieved | **Not claimed** |

### Compatibility

- New `stop-workflow` is backward-compatible with installed Driver (returns success + optional `payment_capture_deferred`; Rate path unchanged).  
- New tip Edge is backward-compatible with older Customer (still returns success on durable accept; older clients that awaited full capture still succeed when deferred returns early).  
- New Customer OTA requires tip Edge v92 for Home-before-Revolut behaviour on tip>0.

### Pending tip job durable recovery (Edge background terminates)

| Layer | Coverage |
| --- | --- |
| Accept | Tip amount + mutex `processing` stamped before HTTP return |
| In-flight | `EdgeRuntime.waitUntil` via `scheduleEdgeBackground` |
| Duplicate / ambiguous | `CLAIM_HELD` / `TIP_WINDOW_PROCESSING` / UNKNOWN retains claim |
| After window expiry | `capture-expired-tip-windows` (includes `processing`) |
| Fare if tip stamp missing after Complete | `sweep-revolut-stale-holds` AUTHORISED/`capture_requested` retry |

---

## 6. CI evidence (pre-deploy)

| Repo | SHA | CI |
| --- | --- | --- |
| admin-new | `d1978629` | success (fail-closed) |
| admin-new | `20a9d2ea` | https://github.com/awehliye44-create/admin-new/actions/runs/43717544383 |
| Customer | `b3f2f3f` / `194a3a5` | https://github.com/awehliye44-create/onecab-customer-native/actions/runs/43717546687 |

---

## 7. Rollback

1. Redeploy prior Edge: `stop-workflow` **v672**; `submit-customer-trip-tip` **v91**.  
2. Customer OTA rollback to groups `940760dc-…` / `12de3a4d-…` (`f25365ba`).  
3. Driver: no change.

---

## 8. Recommended personal device test focus

1. Driver Complete → Rate (card trip; note timing).  
2. Customer Submit / Submit+tip / Skip → Home.  
3. Tip with bank decline / continue without tip.  
4. Multi-stop intermediate refuse; stacked handover.  
5. Confirm tip never shown as paid until confirmed.
