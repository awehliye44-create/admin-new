# Ops Intelligence — Phase 1 Completion Report

**Date:** 2026-06-24  
**Status:** Implemented locally — **NOT deployed to production** (per approval scope)  
**Repos touched:** `onecab-comfy-ride`, `drive-hub-buddy`, `admin-new`

---

## Summary

Phase 1 adds a **production workflow event ingestion path** and **restores the full Ops detection orchestrator** so Ops Intelligence can surface driver, customer, and backend production issues — not only `admin_panel_slow` performance alerts.

| Deliverable | Status |
|-------------|--------|
| `ingest-ops-event` edge function | ✅ Implemented |
| `ops_workflow_events` table + `ops_ingest_workflow_event` RPC | ✅ Migration written |
| Driver app workflow telemetry | ✅ Wired (13 event types) |
| Customer app workflow telemetry | ✅ Wired (5 event types) |
| Backend workflow + SQL detectors | ✅ Wired (5 event types + 5 SQL detectors) |
| Detector orchestrator restored | ✅ Merged 53245 + 73051 + perf + Phase 1 |
| Ops dashboard categorization | ✅ Updated |
| Production deploy | ❌ **Not done** — awaiting review |

---

## 1. Events added

### Driver app → `ingest-ops-event`

| Event | Wired from |
|-------|------------|
| `driver_accept_timeout` | `acceptTelemetry.logAcceptRpcFailed` (timeout) |
| `driver_accept_false_timeout` | `GlobalRideOfferOverlay.tryRecoverAcceptAfterTimeout` |
| `driver_offer_chips_late` | `GlobalOfferListener` (preset count < min on offer render) |
| `driver_offer_flicker` | ⚠️ **Not wired** — needs offer-state churn detector (Phase 1.1) |
| `driver_stacked_accept_timeout` | `invokeAcceptStackedOffer` |
| `driver_arrive_slow` | `useTripStops.callWorkflow` (≥8s) |
| `driver_start_slow` | `useTripStops.callWorkflow` (≥8s) |
| `driver_complete_slow` | `useTripStops.callWorkflow` (≥8s) |
| `driver_map_marker_stuck` | `NativeMap` create failure |
| `driver_recenter_failed` | `NativeMap.performMapRecenter` catch |
| `driver_zoom_control_failed` | `NativeMap` zoom when map not ready |
| `driver_self_signout` | `sessionManager.signOutWithCleanup` (manual) |
| `driver_ghost_notification` | `handleRideOfferNotificationIntent` stale tap |

### Customer app → `ingest-ops-event`

| Event | Wired from |
|-------|------------|
| `customer_active_trip_flash` | `RideTracking` mount tracker (`trackRideTrackingMount`) |
| `customer_white_screen` | `App.tsx` `RouteErrorBoundary` |
| `customer_call_mask_failed` | `useCallMasking` (create / no masked number) |
| `customer_signup_email_failed` | `Auth.tsx` signup edge error |
| `customer_phone_verification_order_violation` | `send-customer-phone-otp` (EMAIL_NOT_VERIFIED) |

### Backend → `ingest-ops-event` / SQL detectors

| Event | Source |
|-------|--------|
| `call_masking_provider_failed` | `call-masking` edge (`SESSION_CREATE_FAILED`) + `opsLog` |
| `contradictory_trip_state` | SQL `ops_detect_contradictory_trip_state` |
| `rematch_assignment_failed` | SQL `ops_detect_rematch_assignment_failed` (`booking_delivery_log`) |
| `offer_presets_missing` | SQL `ops_detect_offer_presets_missing` |
| `dispatch_timeout_exceeded` | SQL `ops_detect_dispatch_timeout_exceeded` |

---

## 2. Detectors restored (53245 vs 73051)

Migration `20260331073051` reduced `ops_run_all_detections()` from **~30 detectors** to **11**.

**Restored in** `20260724120000_ops_phase1_workflow_events.sql`:

| Detector | Origin | Category |
|----------|--------|----------|
| `ops_detect_failed_payments` | 53245 | Money |
| `ops_detect_failed_payouts` | 53245 | Money |
| `ops_detect_payment_gaps` | 62533 | Money |
| `ops_detect_earning_gaps` | 62533 | Money |
| `ops_detect_payout_failures` | 62533 | Money |
| `ops_detect_stuck_dispatch` | 53245 / 62533 | Dispatch |
| `ops_detect_duplicate_commissions` | 53245 | Duplication |
| `ops_detect_duplicate_bookings` | 53245 | Duplication |
| `ops_detect_duplicate_earnings` | 53245 | Duplication |
| `ops_detect_duplicate_dispatches` | 53245 | Duplication |
| `ops_detect_repeated_webhooks` | 53245 | Duplication |
| `ops_detect_repeated_guest_submissions` | 53245 | Duplication |
| `ops_detect_guest_quote_failures` | 53245 | Guest |
| `ops_detect_guest_checkout_failures` | 53245 | Guest |
| `ops_detect_guest_booking_not_confirmed` | 53245 | Guest |
| `ops_detect_guest_dropoffs` | 53245 | Guest |
| `ops_detect_guest_latency` | 53245 | Guest |
| `ops_detect_error_spikes` | 53245 | Logs |
| `ops_detect_fatal_logs` | 53245 | Logs |
| `ops_detect_5xx_spikes` | 53245 | Logs |
| `ops_detect_latency_spikes` | 53245 | Logs |
| `ops_detect_edge_function_failures` | 53245 | Backend |
| `ops_detect_webhook_failures` | 53245 | Backend |
| `ops_detect_corporate_booking_issues` | 63012 | Corporate |
| `ops_detect_slow_screens` | 31100249 | Performance |
| `ops_detect_money_screen_delays` | 31100249 | Performance |
| `ops_detect_api_latency_spikes` | 31100249 | Performance |
| `ops_detect_version_issues` | 31100249 | Performance |
| `ops_detect_notification_failures` | **New** (`booking_delivery_log.push_failed`) | Dispatch |
| `ops_detect_workflow_event_spikes` | **New** | Workflow |

**Retained from 73051:** money integrity, app perf (customer/driver/admin/guest/corporate), `ops_detect_log_anomalies`.

---

## 3. Database changes

**Migration:** `supabase/migrations/20260724120000_ops_phase1_workflow_events.sql`

| Object | Purpose |
|--------|---------|
| `ops_workflow_events` | Raw workflow telemetry with full metadata |
| `ops_ingest_workflow_event()` | Insert event + `ops_logs` + alert + `ops_events` |
| `ops_workflow_event_category()` / `_app()` | Taxonomy helpers |
| 5 backend SQL detectors | Trip invariants, rematch, presets, dispatch timeout |
| `ops_detect_notification_failures()` | Push failures from `booking_delivery_log` |
| `ops_detect_workflow_event_spikes()` | 3+ same event in 15 min |
| `ops_run_all_detections()` | Full merged orchestrator |

**Metadata captured per event:** `trip_id`, `driver_id`, `customer_id`, `event_type`, `error_code`, `duration_ms`, `app_version`, `platform`, `device_model`, `os_version`, `session_id`, `timestamp` (`created_at`).

---

## 4. Files changed

### onecab-comfy-ride (backend SSOT)

| File | Change |
|------|--------|
| `supabase/migrations/20260724120000_ops_phase1_workflow_events.sql` | New |
| `supabase/functions/ingest-ops-event/index.ts` | New |
| `supabase/functions/_shared/opsLog.ts` | New |
| `supabase/functions/call-masking/index.ts` | `opsLog` on session create failure |
| `supabase/functions/send-customer-phone-otp/index.ts` | Phone order violation ingest |
| `src/lib/opsWorkflowEvent.ts` | Customer SDK |
| `src/hooks/useCallMasking.ts` | Call mask failure events |
| `src/pages/RideTracking.tsx` | Active trip flash tracker |
| `src/pages/Auth.tsx` | Signup email failure events |
| `src/App.tsx` | White screen / error boundary events |

### drive-hub-buddy

| File | Change |
|------|--------|
| `src/lib/opsWorkflowEvent.ts` | Driver SDK |
| `src/lib/acceptTelemetry.ts` | Accept timeout → ops |
| `src/lib/invokeAcceptStackedOffer.ts` | Stacked timeout → ops |
| `src/lib/handleRideOfferNotificationIntent.ts` | Ghost notification → ops |
| `src/hooks/useTripStops.ts` | Slow arrive/start/complete → ops |
| `src/auth/sessionManager.ts` | Self signout → ops |
| `src/components/GlobalRideOfferOverlay.tsx` | False accept timeout → ops |
| `src/components/GlobalOfferListener.tsx` | Chips late → ops |
| `src/components/maps/NativeMap.tsx` | Recenter/zoom/map create failures → ops |

### admin-new

| File | Change |
|------|--------|
| `supabase/migrations/20260724120000_ops_phase1_workflow_events.sql` | Mirrored |
| `supabase/functions/ingest-ops-event/index.ts` | Mirrored |
| `supabase/functions/_shared/opsLog.ts` | Mirrored |
| `src/pages/OpsIntelligence.tsx` | Workflow alert categorization |
| `scripts/seed-ops-phase1-test-events.sh` | Local test harness |

---

## 5. Screenshots

**Not captured in this pass** — production was not deployed and admin panel was not run locally against a migrated database.

**Expected UI after deploy + seed:**

1. **Ops Intelligence → Driver App tab** — alerts titled e.g. *Driver Accept False Timeout*, *Driver Offer Chips Late*
2. **Customer App tab** — *Customer Call Mask Failed*, *Customer Active Trip Flash*
3. **Performance / Dispatch tabs** — *Call Masking Provider Failed*, *Contradictory Trip State*, *Notification Failed*
4. **Alert detail** — `metadata.event_type`, `trip_id`, `error_code`, `duration_ms` populated

---

## 6. Sample alerts (test harness)

Run after migration + edge function deploy to **staging**:

```bash
export SUPABASE_URL="https://thazislrdkjpvvghtvzo.supabase.co"
export SUPABASE_SERVICE_ROLE_KEY="<service-role-key>"
bash admin-new/scripts/seed-ops-phase1-test-events.sh
```

**Expected `ingest-ops-event` response:**

```json
{
  "success": true,
  "ingested": 5,
  "event_ids": ["<uuid>", "..."]
}
```

**Expected alerts in `ops_alerts`:**

| Fingerprint prefix | Category | Source |
|--------------------|----------|--------|
| `driver_accept_false_timeout:` | driver_app | workflow |
| `driver_offer_chips_late:` | driver_app | workflow |
| `customer_call_mask_failed:` | customer_app | workflow |
| `call_masking_provider_failed:` | backend | workflow |
| `contradictory_trip_state:` | backend | workflow |

---

## 7. Acceptance test mapping

| # | Test | Implementation |
|---|------|----------------|
| 1 | Accept false timeout | `driver_accept_false_timeout` in overlay recovery |
| 2 | Preset chips late | `driver_offer_chips_late` in GlobalOfferListener |
| 3 | Call masking failure | Customer `customer_call_mask_failed` + backend `call_masking_provider_failed` |
| 4 | Contradictory trip state | SQL `ops_detect_contradictory_trip_state` |
| 5 | Driver gesture/map issues | `driver_recenter_failed`, `driver_zoom_control_failed`, `driver_map_marker_stuck` |
| 6 | AI summary | **Not in Phase 1** (unchanged) |
| 7 | Fix It / auto-remediation | **Not in Phase 1** (unchanged) |
| 8 | Alerts in Ops Intelligence | Dashboard tabs + `source=workflow` alerts |

---

## 8. Deploy checklist (when approved)

1. `supabase db push` — apply `20260724120000_ops_phase1_workflow_events.sql`
2. Deploy edge functions: `ingest-ops-event`, updated `call-masking`, `send-customer-phone-otp`
3. Rebuild + ship **driver app** and **customer app** (workflow SDK)
4. Deploy **admin panel** (OpsIntelligence categorization)
5. Run `scripts/seed-ops-phase1-test-events.sh` on staging
6. Verify Ops Intelligence tabs show non-admin alerts
7. Confirm pg_cron `ops-run-detections` runs restored orchestrator

---

## 9. Known gaps (Phase 1.1)

| Item | Notes |
|------|-------|
| `driver_offer_flicker` | Needs offer UI state churn instrumentation |
| `driver_gesture_freeze` | Needs gesture watchdog on ActiveTrip shell |
| Log-based detectors | Require ongoing `ops_logs` writes from more edge functions |
| Screenshots | Capture post-staging deploy |
| `customer_id` on phone OTP violation | Uses `user_id` in metadata until customer row resolved |

---

## 10. Explicitly NOT implemented (per scope)

- AI auto-summary generation
- AI auto-fix / Fix It changes
- Automatic deployments
- Auto-remediation / autonomous repair RPC execution
