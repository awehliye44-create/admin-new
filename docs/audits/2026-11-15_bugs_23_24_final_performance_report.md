# Bugs #23 / #24A/B/C — Final consolidated performance report

**Date:** 2026-11-15  
**Backend release tip to preserve:** `d1978629` (CAPTURE_QUEUE_FAILED fail-closed) **plus** follow-up idempotent capture-queue recovery on this tip.  
**Production pins (live, unchanged until deploy approval):** mig `20270225140000`; Customer OTA `f25365ba`; Driver OTA `9db6b5cc`; `stop-workflow` **v672**.  
**All production Edge / OTA / native / store uploads remain paused.**  
**Device performance targets are not claimed.**

---

## Bug #23 — Driver Complete Trip → Rate

### Root cause
Awaited Revolut `finalize-trip-and-capture` (and tip-window TEN) on the Complete HTTP response.

### After
1. Persist `status=completed` + fare/waiting facts  
2. Stamp durable `capture_requested` (or tip-window) — **fail closed** (`CAPTURE_QUEUE_FAILED`) if stamp write errors  
3. Queue finalize/TEN via `scheduleEdgeBackground`  
4. Return `payment_capture_deferred: true` → Rate immediately  

### CAPTURE_QUEUE_FAILED recoverability — PASS

| Requirement | Result |
| --- | --- |
| Completion already persisted; retry recovers stamp without duplicate completion/settlement/capture | **PASS** — idempotent `status=completed` path stamps `capture_requested` (CAS on recoverable hold statuses) and queues finalize; does not re-write completion |
| Driver not permanently stuck on Complete | **PASS** — first failure is retryable 500; retry returns success → Rate; even if recover stamp fails again, Rate success + sweeper covers AUTHORISED completed |
| Stale snapshots do not reopen completed trip | **PASS** — completion latch + Rate seed unchanged; idempotent success seeds Rate |
| Sweeper covers completed without queue stamp | **PASS** — `sweep-revolut-stale-holds` retries AUTHORISED/`capture_requested`/`capture_failed` completed (90s grace); tip window open skipped |
| Normal success remains non-blocking | **PASS** — Revolut still off the Rate path |

### Backend tip for release
Include commits through capture-queue fail-closed **`d1978629`** and the idempotent recovery follow-up on `main` (this tip).

### Driver OTA
**Not required** — `03a31b9` was test-only.

---

## Bug #24A — Submit rating → Home

### Root cause
2.2s thanks toast gated Home; extra pending RPC.

### After
Durable rating → Home immediately; pending hydrate async; toast not a gate.

---

## Bug #24B — Submit rating + tip → Home

### Clarification
Prior client `void` tip after Home was **fire-and-forget — rejected**.

### After
1. Durable rating  
2. **Await** Edge durable tip accept (tip stamp + mutex) → `tip_accepted` / `tip_capture_deferred` (**pending**, not paid)  
3. Home  
4. Backend `scheduleEdgeBackground` finalize/seal (same `submit_customer_trip_tip` finalize SSOT)  

| Scenario | Result |
| --- | --- |
| App terminated after Home | Tip intent already claimed (`processing`); Edge `waitUntil` continues |
| Connectivity loss before accept | Tip accept fails; rating saved; refuse dialog / Home |
| Auth decline | Background release + clear tip; never claimed paid on accept |
| Duplicate tip | Mutex `CLAIM_HELD` / `TIP_WINDOW_PROCESSING` / `TIP_ALREADY_SUBMITTED` |
| Ambiguous provider | Claim retained; no blind second POST |
| Driver 100% tip | Unchanged tip credit SSOT |

---

## Bug #24C — Skip → Home

Durable dismiss → Home; tip close non-blocking; hydrate skips `resolvedTripId`.

---

## Stale pending-rating reopen (#24A/C)

Feedback row before Home; `goHome` clears completed store; hydrate excludes resolved trip id.

---

## Timing instrumentation

| Stage | Meaning |
| --- | --- |
| `home_screen_visible` / Rate visible | Navigation committed |
| `home_screen_interactive` | `InteractionManager.runAfterInteractions` |

Isolated delayed-finance execution tests pass (250ms finance after UI ready). **Not device proof.**

---

## SHAs (code)

| Repo | SHA | Role |
| --- | --- | --- |
| admin-new | `d1978629` | Preserve — CAPTURE_QUEUE_FAILED fail-closed |
| admin-new | *(this tip)* | Idempotent capture recover + #24B locks/report |
| Customer | `b3f2f3f` + tip durable-accept tests | #24A/B/C |
| Driver | `03a31b9` | Test-only |

---

## Deploy order (when approved)

1. Edge `stop-workflow` (include `d1978629` + idempotent recover)  
2. Edge `submit-customer-trip-tip`  
3. Customer OTA  
4. No Driver OTA  
5. Measure production devices before claiming targets  

**Migrations:** none.  
**Rollback:** prior `stop-workflow` v672; prior tip Edge; Customer OTA `f25365ba`.
