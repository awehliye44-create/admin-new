# Ops Intelligence — Issue Coverage + AI Summary/Fix Workflow Audit

**Date:** 2026-06-24  
**Repo:** `admin-new` (Ops Intelligence UI + detection engine)  
**Related:** `onecab-comfy-ride` (customer), `drive-hub-buddy` (driver), Supabase edge functions  
**Status:** Audit only — no implementation in this pass

---

## Executive summary

Ops Intelligence today is a **performance + money-integrity dashboard**, not a **production workflow incident system**. It surfaces slow admin-panel screens and (when data exists) average slow customer/driver screen loads. It does **not** ingest the driver trip-action failures, call masking errors, signup OTP issues, or trip-state invariant violations that operations is seeing in the field.

| Area | Current state | Gap |
|------|---------------|-----|
| Driver workflow issues | Console logs only (`OneCabAccept`, arrive telemetry) | Not in `ops_logs` or `ops_events` |
| Customer workflow issues | Partial screen/API telemetry | No state-flash / call-mask / signup events |
| Backend edge failures | No production writer to `ops_logs` | Detectors exist but starved |
| AI summary | Manual button; 3 text fields | No auto-generate; silent empty state |
| Fix workflow | 7 finance/dispatch RPCs only | UI/perf alerts always “no fix” |
| Detection orchestrator | 11 detectors | 20+ detectors dropped in migration `73051` |

---

## 1. Current ingested event sources

### 1.1 What feeds Ops Intelligence today

| Source | Table / endpoint | How data arrives | Used by detections? |
|--------|------------------|------------------|---------------------|
| **Customer app** | `app_performance_events` | `POST /functions/v1/ingest-telemetry` via `customerTelemetry` | Yes — slow screen/API only |
| **Driver app** | `app_performance_events` | Same via `driverTelemetry` (`driver_app`) | Yes — slow screen/API only |
| **Admin panel** | `app_performance_events` | `AdminTelemetryProvider` + fetch interceptor (`admin_panel`) | Yes — primary visible alerts |
| **Guest / corporate web** | `app_performance_events` | Template integration | Yes — slow screens only |
| **Structured ops logs** | `ops_logs` | **No production writer** (only `ops-seed` demo) | Detectors exist, no live feed |
| **Ops events** | `ops_events` | `ops_record_event()` from SQL detectors | Yes — links events to alerts |
| **Financial DB** | `trips`, `trip_finance`, `payout_items`, etc. | SQL detectors scan directly | Partially (money integrity) |
| **Edge function logs** | — | Not ingested | No |
| **Supabase platform logs** | — | Not ingested | No |
| **Realtime trip updates** | — | Not ingested into ops | No |
| **Call masking** | — | `call-masking` does not write `ops_logs` / `ops_events` | No |
| **Notifications / OTP** | — | No ops pipeline | No |
| **Payment / wallet** | `trip_finance`, payouts | SQL money detectors | Yes when orchestrator runs |

### 1.2 Telemetry ingestion rules (`ingest-telemetry`)

**File:** `supabase/functions/ingest-telemetry/index.ts`

- Valid apps: `customer_app`, `driver_app`, `guest_web`, `admin_web`, `admin_panel`, `corporate_web`
- Valid metrics: `screen_load_time`, `api_latency`, `transaction_time`, `ttfb`, `render_time`, `interaction_delay`, `network_request_time`
- **Server-side floor:** events below 300–500ms are **dropped** before storage (driver app sets thresholds to 0 client-side, but server still filters)
- Metadata on events is **not** used by detectors for workflow taxonomy

### 1.3 Driver app — why trip-action issues are missing

Driver app **does** ship telemetry (`driverTelemetry`) for screen/API/flow timers on ActiveTrip, Wallet, Earnings, etc.

**But workflow telemetry is console-only:**

| Module | Events | Sent to Ops? |
|--------|--------|--------------|
| `acceptTelemetry.ts` | `ACCEPT_BUTTON_TAP`, `ACCEPT_RPC_FAILED`, `ACCEPT_BLOCKED_REASON`, … | **No** — `console.log` only |
| `arrivePickupTelemetry.ts` | Arrive-at-pickup lifecycle | **No** — grep-able logs only |
| `offerActionTelemetry.ts` | Offer accept/decline tap events | **No** — console only |
| `driverTelemetry` | `screen_load_time`, `api_latency`, `transaction_time` | Yes — if slow enough |

**Detection logic** (`ops_detect_driver_app_issues`) only flags screens where **average** `screen_load_time` or `api_latency` > **3000ms** over 1 hour. It does not:

- Detect accept timeout toasts
- Detect false-positive timeouts (trip assigned after timeout UI)
- Detect preset chip delay, stacked ride timeout, map control freeze, gesture freeze
- Read `transaction_time` for arrive/start/complete slowness

### 1.4 Customer app — gaps

Customer app sends `customerTelemetry` on Home, BookRide, RideTracking, Wallet, Payment, etc.

**Missing from ops pipeline:**

- Active trip UI flash / remount loops
- Call masking failure (`CUSTOMER_LOGIN_ERROR_SHOWN` / `call-masking:no-masked-number`)
- Signup OTP sequence failures
- Rate/fare mismatch on trip complete
- White screen / error boundary crashes (unless wrapped in slow screen metric)

### 1.5 Admin panel — what dominates today

`ops_detect_admin_panel_issues()` creates alerts like `admin_panel_slow:opsintelligence`, `admin_panel_slow:dashboard` when admin telemetry exceeds thresholds.

This explains why Ops Intelligence **feels like an admin perf tool** rather than a fleet-wide incident board.

### 1.6 Backend / edge — gaps

- **No edge function** writes structured rows to `ops_logs` on failure
- **`ops_detect_log_anomalies`** expects `ops_logs` with `level IN ('error','fatal')` — table is empty in production
- **Earlier detectors** (`ops_detect_stuck_dispatch`, `ops_detect_5xx_spikes`, `ops_detect_fatal_logs`, `ops_detect_webhook_failures`, …) exist in migration `20260331053245` but were **removed** from `ops_run_all_detections` in `20260331073051`

### 1.7 Current detection orchestrator (production)

**File:** `supabase/migrations/20260331073051_*.sql` — `ops_run_all_detections()` runs every 5 minutes via pg_cron → `ops-run-detections`:

1. `ops_detect_missing_commissions`
2. `ops_detect_missing_earnings`
3. `ops_detect_commission_gaps`
4. `ops_detect_duplicate_payments`
5. `ops_detect_duplicate_payouts`
6. `ops_detect_customer_app_issues` (slow screens)
7. `ops_detect_driver_app_issues` (slow screens)
8. `ops_detect_guest_booking_failures` (repurposed → slow guest web)
9. `ops_detect_corporate_web_issues`
10. `ops_detect_admin_panel_issues`
11. `ops_detect_log_anomalies` (starved — no logs)

**Cron:** `ops-run-detections` edge function also auto-resolves stale alerts before running detections.

---

## 2. Event taxonomy — required vs implemented

### 2.1 Driver app (required)

| Event | Implemented? | Notes |
|-------|--------------|-------|
| `driver_accept_timeout` | ❌ | Accept telemetry is console-only |
| `driver_accept_recovered` | ❌ | No false-timeout detector |
| `driver_offer_chips_late` | ❌ | |
| `driver_offer_flicker` | ❌ | |
| `driver_stacked_accept_timeout` | ❌ | |
| `driver_arrive_slow` | ⚠️ | `transaction_time` possible but unused in detectors |
| `driver_start_slow` | ⚠️ | Same |
| `driver_complete_slow` | ⚠️ | Same |
| `driver_map_marker_stuck` | ❌ | |
| `driver_zoom_control_failed` | ❌ | |
| `driver_recenter_failed` | ❌ | |
| `driver_gesture_freeze` | ❌ | |
| `driver_self_signout` | ❌ | |
| `driver_ghost_alert` | ❌ | |

### 2.2 Customer app (required)

| Event | Implemented? | Notes |
|-------|--------------|-------|
| `customer_active_trip_flash` | ❌ | |
| `customer_white_screen` | ❌ | |
| `customer_call_mask_failed` | ❌ | Call masking logs to console/Sentry only |
| `customer_rate_fare_mismatch` | ❌ | |
| `customer_signup_sequence_failed` | ❌ | |

### 2.3 Backend (required)

| Event | Implemented? | Notes |
|-------|--------------|-------|
| `contradictory_trip_state` | ❌ | No SQL invariant detector |
| `dispatch_timeout_exceeded` | ⚠️ | Detector existed, dropped from orchestrator |
| `rematch_assignment_failed` | ❌ | |
| `offer_presets_missing` | ❌ | |
| `call_masking_provider_failed` | ❌ | |
| `payout_guard_block` | ⚠️ | Partial money detectors only |
| `signup_backend_invariant_failed` | ❌ | |

### 2.4 Admin (required)

| Event | Implemented? | Notes |
|-------|--------------|-------|
| `admin_panel_slow` | ✅ | `admin_panel_slow:*` fingerprints |
| `admin_map_blank` | ❌ | Fixed in code but no ops event |
| `admin_live_fleet_static` | ❌ | |
| `admin_fix_action_unavailable` | ❌ | UX issue, not instrumented |

---

## 3. Alert creation rules — required vs actual

### 3.1 Required rules (from spec)

| Trigger | Required alert | Current |
|---------|----------------|---------|
| Accept timeout toast but trip assigned | `driver_accept_false_timeout` | ❌ |
| Offer card without preset chips | `driver_offer_chips_late` | ❌ |
| `status=cancelled` + `dispatch_status=assigned` | `contradictory_trip_state` | ❌ |
| Call masking failure | `call_masking_provider_failed` | ❌ |
| Edge function `duration_ms` > SLA | Per-function alert | ❌ |
| Failed network request + user toast | Client ops event | ❌ |
| DB invariant violation | Backend alert | Partial (money only) |

### 3.2 Actual alert creation (`ops_upsert_alert`)

- **Fingerprint dedup:** one open/acknowledged alert per fingerprint
- **Categories:** `payment`, `commission`, `earning`, `payout`, `dispatch`, `guest_booking`, `corporate_booking`, `customer_app`, `driver_app`, `backend`, `logs`, `duplication`, `system`
- **Severity:** `info`, `warning`, `critical`, `fatal`
- **Status:** `open`, `acknowledged`, `resolved`, `suppressed`
- **Entity links:** `related_trip_id`, `related_driver_id`, `related_payment_id`, `related_payout_batch_id`, `metadata` jsonb

**Gap:** No `event_type` column for fine-grained taxonomy — only `title` + `fingerprint` + `metadata`.

---

## 4. AI summary — current behaviour and failures

### 4.1 Flow

1. Admin opens alert → **OpsAlertDetail**
2. User clicks **Generate Summary** (not automatic)
3. `ops-ai-summary` edge function:
   - Loads alert from `ops_alerts`
   - Loads up to 10 related `ops_logs` (±5 min around `last_detected_at`)
   - Calls Lovable AI Gateway (`google/gemini-3-flash-preview`)
   - Inserts into `ops_alert_summaries` (`summary`, `root_cause`, `recommended_action`)

### 4.2 Why summaries are missing or empty

| Reason | User sees | Fix needed |
|--------|-----------|------------|
| User never clicked Generate | **"No AI summary yet"** (silent) | Auto-generate on alert create; show reason |
| `LOVABLE_API_KEY` not set | Error on generate | Config check in UI |
| AI rate limit / credits | 429 / 402 message | Billing + retry UI |
| No related `ops_logs` | Thin context → weak summary | Ingest real logs |
| Alert is generic perf | AI has no trip/driver context | Richer metadata on alerts |

### 4.3 Gaps vs required summary fields

| Required field | Implemented? |
|----------------|--------------|
| What happened | ✅ `summary` |
| Affected app | ⚠️ In alert row, not always in summary |
| trip_id / driver_id / customer_id | ⚠️ Only if set on alert |
| Likely root cause | ✅ `root_cause` |
| Production evidence | ❌ Not structured |
| Recommended fix | ✅ `recommended_action` |
| Priority | ❌ |
| Affected files/functions | ❌ |
| Acceptance test | ❌ |
| Exact failure reason when cannot generate | ❌ Shows "No AI summary yet" |

**File:** `src/components/ops/OpsAlertDetail.tsx` line ~409 — `"No AI summary yet"` with no explanation.

---

## 5. Fix workflow — current behaviour

### 5.1 Fix availability logic

**File:** `src/components/ops/OpsAiFixPanel.tsx`

```typescript
const isFixable = proposal && proposal.function_name !== 'none' && proposal.param_value;
```

**Allowed fix functions** (`ops-ai-fix` whitelist only):

| Function | Risk | Param |
|----------|------|-------|
| `repair_missing_commission` | MEDIUM | `p_trip_id` |
| `repair_missing_driver_earning` | MEDIUM | `p_trip_id` |
| `repair_missing_financials` | MEDIUM | `p_trip_id` |
| `retry_failed_dispatch` | MEDIUM | `p_trip_id` |
| `resolve_alert_if_cleared` | LOW | `p_alert_id` |
| `replay_webhook` | MEDIUM | `p_event_id` |
| `retry_failed_payout` | HIGH | `p_payout_id` |

### 5.2 Why “Fix unavailable” appears

| Reason | Code path |
|--------|-----------|
| AI returns `function_name: "none"` | No matching repair for alert category |
| `param_value` not a UUID | Forced to `none` — "alert lacks a specific entity ID" |
| Performance/UI alert | No `related_trip_id` in metadata |
| Driver/customer workflow alert | No repair RPC exists |
| super_admin user | `ops-ai-fix` checks `role = 'admin'` only — may 403 |

**UI copy:** *"No automated fix available for this alert. Manual intervention required."* — does not explain which reason applies.

### 5.3 Gaps vs required fix workflow

| Required status | Implemented? |
|-----------------|--------------|
| Fix available | ✅ For 7 finance/dispatch RPCs |
| Fix not available | ✅ But vague message |
| Needs investigation | ❌ |
| Already resolved | ⚠️ Manual status only |
| Suppressed | ⚠️ `suppressed_until` exists |
| Explain why unavailable | ❌ |
| Fix **proposal** (files, risk, test, rollback) | ❌ Executes RPC immediately |
| Approval before code/deploy | ❌ "Approve & Run Fix" runs SQL RPC in prod |

**Tables:** `ops_fix_actions` audits RPC execution — not code-change proposals.

---

## 6. “Fix it” action — actual vs required

### Required

1. Create fix proposal (files, risk, test plan, rollback)
2. Require human approval
3. **No blind production deploy**

### Actual

1. **Analyze & Propose Fix** → AI picks from 7 RPCs
2. **Approve & Run Fix** → executes RPC immediately against production DB
3. No repo mapping, no branch, no PR, no deploy gate

**Not connected:** `recommended_action` from AI summary ≠ Fix It button (separate panels).

---

## 7. Database schema — current and proposed

### 7.1 Current tables

| Table | Purpose |
|-------|---------|
| `ops_alerts` | Central alerts (realtime-enabled) |
| `ops_logs` | Structured logs — **no prod writer** |
| `ops_events` | Event stream linked to alerts |
| `ops_alert_rules` | Seeded config — not driving cron |
| `ops_alert_summaries` | AI summaries (active) |
| `ops_ai_summaries` | Legacy — unused by edge function |
| `ops_fix_actions` | Fix execution audit |
| `app_performance_events` | Telemetry |
| `app_performance_thresholds` | Per-screen thresholds |

**No `incidents` table** — alerts are the incident primitive.

### 7.2 Proposed schema additions

```sql
-- Fine-grained workflow events (client + edge)
CREATE TABLE ops_workflow_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL,          -- driver_accept_timeout, etc.
  app_name text NOT NULL,
  severity text NOT NULL DEFAULT 'warning',
  trip_id uuid,
  driver_id uuid,
  customer_id uuid,
  session_id text,
  device_model text,
  metadata jsonb,
  created_at timestamptz DEFAULT now()
);

-- Fix proposals (separate from execution)
CREATE TABLE ops_fix_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_id uuid REFERENCES ops_alerts(id),
  status text NOT NULL,              -- draft, pending_approval, approved, rejected, applied
  risk_level text,
  affected_files jsonb,
  test_plan text,
  rollback_plan text,
  proposal_json jsonb,
  created_by uuid,
  approved_by uuid,
  created_at timestamptz DEFAULT now()
);

-- Extend ops_alerts
ALTER TABLE ops_alerts ADD COLUMN IF NOT EXISTS event_type text;
ALTER TABLE ops_alerts ADD COLUMN IF NOT EXISTS fix_status text;  -- available, unavailable, needs_investigation, resolved, suppressed
ALTER TABLE ops_alerts ADD COLUMN IF NOT EXISTS fix_unavailable_reason text;

-- Extend ops_alert_summaries
ALTER TABLE ops_alert_summaries ADD COLUMN IF NOT EXISTS priority text;
ALTER TABLE ops_alert_summaries ADD COLUMN IF NOT EXISTS affected_files jsonb;
ALTER TABLE ops_alert_summaries ADD COLUMN IF NOT EXISTS acceptance_test text;
ALTER TABLE ops_alert_summaries ADD COLUMN IF NOT EXISTS generation_error text;
ALTER TABLE ops_alert_summaries ADD COLUMN IF NOT EXISTS generation_status text;
```

---

## 8. Required telemetry additions

### 8.1 Client SDK — shared `opsWorkflowEvent()`

Add to both apps (and admin where relevant):

```typescript
opsWorkflowEvent({
  event_type: 'driver_accept_timeout',
  app_name: 'driver_app',
  severity: 'critical',
  trip_id,
  driver_id,
  metadata: { rpc_ms, recovered: true, offer_id },
});
```

**Destination:** new edge function `ingest-ops-event` → `ops_workflow_events` + optional `ops_upsert_alert` for critical types.

### 8.2 Driver app — wire existing console telemetry

| File | Action |
|------|--------|
| `acceptTelemetry.ts` | Also call `opsWorkflowEvent` on FAILED/TIMEOUT/RECOVERED |
| `arrivePickupTelemetry.ts` | Emit `driver_arrive_slow` when transition > SLA |
| `offerActionTelemetry.ts` | Emit chip delay / flicker events |
| Active trip map | Emit `driver_recenter_failed`, `driver_gesture_freeze` |
| `useCallMasking.ts` (driver) | Emit `customer_call_mask_failed` mirror → `call_masking_provider_failed` |

### 8.3 Customer app

| Area | Event |
|------|-------|
| `useCallMasking.ts` | `customer_call_mask_failed` |
| `RideTracking` mount churn | `customer_active_trip_flash` |
| Signup / OTP flow | `customer_signup_sequence_failed` |
| Trip complete rating | `customer_rate_fare_mismatch` |

### 8.4 Edge functions — structured failure logging

Add shared helper `_shared/opsLog.ts`:

```typescript
await opsLog({
  level: 'error',
  source: 'call-masking',
  event_type: 'call_masking_provider_failed',
  trip_id,
  message,
  metadata: { msg91_status, block_code },
});
```

**Wire into:** `call-masking`, `accept-trip`, `driver-send-preset-offer`, `guard-onboarding-login`, `finalize-trip-and-capture`, dispatch orchestrator, OTP functions.

### 8.5 SQL detectors — restore and extend

1. **Restore** full orchestrator from `20260331053245` (merge with `73051` money detectors)
2. **Add:**
   - `ops_detect_contradictory_trip_state()`
   - `ops_detect_call_masking_failures()` — from `ops_workflow_events` or `ops_logs`
   - `ops_detect_driver_accept_false_timeout()`
   - `ops_detect_signup_invariant_failures()`

---

## 9. Implementation plan (phased)

### Phase 1 — Ingestion foundation (P0, ~1 week)

| # | Task | Owner |
|---|------|-------|
| 1.1 | Create `ingest-ops-event` edge function | Backend |
| 1.2 | Create `ops_workflow_events` table + RLS | Backend |
| 1.3 | Add `opsLog()` helper; wire `call-masking` failures | Backend |
| 1.4 | Wire `acceptTelemetry` → `ingest-ops-event` | Driver app |
| 1.5 | Wire customer `useCallMasking` failures | Customer app |
| 1.6 | Production writer for `ops_logs` from edge errors | Backend |

### Phase 2 — Detection expansion (P0, ~1 week)

| # | Task |
|---|------|
| 2.1 | Restore merged `ops_run_all_detections` orchestrator |
| 2.2 | Add SQL detectors for trip-state invariants |
| 2.3 | Add workflow-event → alert mappers (per taxonomy) |
| 2.4 | Lower/remove server-side telemetry floors for `interaction_delay` |

### Phase 3 — AI summary improvements (P1, ~3–5 days)

| # | Task |
|---|------|
| 3.1 | Auto-generate summary on critical alert create |
| 3.2 | Extend summary schema (priority, files, acceptance test) |
| 3.3 | Replace "No AI summary yet" with `generation_status` + `generation_error` |
| 3.4 | Pull `ops_workflow_events` + trip context into AI prompt |

### Phase 4 — Fix proposal workflow (P1, ~1 week)

| # | Task |
|---|------|
| 4.1 | Create `ops_fix_proposals` table |
| 4.2 | Change Fix It → create proposal (no immediate RPC) |
| 4.3 | Add `fix_status` + `fix_unavailable_reason` on alerts |
| 4.4 | Map event types → fix availability rules |
| 4.5 | Approval UI before any production RPC |

### Phase 5 — Admin coverage (P2)

| # | Task |
|---|------|
| 5.1 | Emit `admin_map_blank` / `admin_live_fleet_static` from admin telemetry |
| 5.2 | Detectors for admin map regressions |

---

## 10. Acceptance test mapping

| # | Test | Current | After Phase 1–2 |
|---|------|---------|-----------------|
| 1 | Accept false timeout | ❌ | ✅ `driver_accept_false_timeout` |
| 2 | Preset chips late | ❌ | ✅ `driver_offer_chips_late` |
| 3 | Call masking failure | ❌ | ✅ `call_masking_provider_failed` |
| 4 | Contradictory trip state | ❌ | ✅ SQL detector |
| 5 | Driver gesture freeze | ❌ | ✅ client event |
| 6 | Generate AI summary | ⚠️ Manual, thin | ✅ Auto + rich fields |
| 7 | Tap Fix It | ⚠️ RPC only | ✅ Proposal + approval |
| 8 | Fix unavailable reason | ❌ Generic | ✅ Explicit reason code |

---

## 11. Key files reference

| Area | Path |
|------|------|
| Ops dashboard | `src/pages/OpsIntelligence.tsx` |
| Alert detail + summary UI | `src/components/ops/OpsAlertDetail.tsx` |
| Fix panel | `src/components/ops/OpsAiFixPanel.tsx` |
| AI summary service | `src/lib/opsAiSummaryService.ts` |
| Telemetry ingest | `supabase/functions/ingest-telemetry/index.ts` |
| Detection cron | `supabase/functions/ops-run-detections/index.ts` |
| AI summary | `supabase/functions/ops-ai-summary/index.ts` |
| AI fix | `supabase/functions/ops-ai-fix/index.ts` |
| Detection orchestrator | `supabase/migrations/20260331073051_*.sql` |
| Driver telemetry | `drive-hub-buddy/src/lib/telemetry/driverTelemetry.ts` |
| Accept telemetry (console only) | `drive-hub-buddy/src/lib/acceptTelemetry.ts` |
| Customer telemetry | `onecab-comfy-ride/src/lib/telemetry/customerTelemetry.ts` |

---

## 12. Conclusion

Ops Intelligence is **architecturally capable** (alerts, summaries, fix audit, realtime, cron) but **operationally blind** to the production issues ONECAB is hitting because:

1. **Workflow events stay in device console logs** — never reach `ops_logs` / `ops_workflow_events`
2. **Detectors only understand slow averages and money** — not trip semantics
3. **Detection orchestrator was regressed** — many backend detectors not scheduled
4. **AI summary is manual and thin** — empty state is silent
5. **Fix workflow is finance-RPC-only** — cannot fix driver/customer UX issues; executes immediately without proposal/approval

The highest-impact first step is **Phase 1.4 + 1.3**: wire driver accept telemetry and call-masking failures into a production ops ingestion path, then add matching SQL alert rules.
