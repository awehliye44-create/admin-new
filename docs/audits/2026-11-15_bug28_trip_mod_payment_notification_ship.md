# Bug #28 — Trip modification payment notifications (ship report)

**Date:** 2026-11-15  
**Status:** **SHIPPED** (backend + Customer OTA). **Not production-accepted** until you retest.  
**Reference:** MK-261115-014  
**Bug #18:** remains **OPEN** (Tier A telemetry preserved; awaiting Revolut).

---

## Root-cause fixes

### Backend
1. `invokePreauthUpdateOnModification` now parses structured non-2xx Edge bodies (`error_code` / `payment_coverage_status` / `decline_reason`) via `readFunctionsInvokeErrorBody` + `invokeErrorBodyHasPaymentStructure`. HTTP status alone is never treated as terminal.
2. `PROVIDER_INCREMENT_FAILED` / `authorization_provider_failed` reach `decideFromPreauthInvokeResult` → `PAYMENT_FAILED` / `failed` (technical) instead of catch → reconciliation pending.
3. Safety net promotes **all** authoritative terminal PSA statuses (`DECLINED`, `FAILED_TERMINAL`, `UNSUPPORTED`) — not only `ADDITIONAL_AUTHORISATION_DECLINED`.
4. Stale pending claim path uses `canPendingOverwriteModificationRequestStatus` so pending cannot overwrite `payment_failed` / `applied` / `expired`.
5. Response now includes `originalFarePence` for Customer dynamic copy. Bug #18 Tier A evidence fields untouched.

### Customer
1. Pending: **Authorising additional payment** + dynamic additional £; Confirm CTA busy label **Authorising…** (no ActivityIndicator).
2. Technical / no issuer evidence: **Payment unsuccessful** + additional £ + original £.
3. Confirmed issuer decline: **Payment declined** + bank message with amounts.
4. Success: **Trip updated** + updated fare £; OK → Assigned.
5. Terminal Alert once per Confirm attempt; OK on payment outcomes discards draft → Assigned (Bug #25).
6. Duplicate submits blocked by `submitLockRef` + busy CTA.

---

## Regression

| Suite | Result |
| --- | --- |
| `bug28TripModPaymentNotificationLock` (admin Deno) | **7 PASS** |
| `tripModificationPaymentGateSSOT` | **15 PASS** |
| `unifiedBankDeclineCopyLock` (admin) | **15 PASS** |
| Customer Bug #28 / UI / bank-decline / Bug #25 / spinner locks | **43+ PASS** (targeted jest) |
| `npm run test:ota-safeguards` | **59 PASS** |
| Paid bookings / historical trip mutation | **Not performed** |

Covered: MK-261115-014 fixture (`PROVIDER_INCREMENT_FAILED`), structured 409, issuer decline, pending timeout/network, FAILED_TERMINAL safety net, stale overwrite guard, Bug #25 discard, dynamic amounts.

---

## Backend deploy

| Function | Version |
| --- | --- |
| `request-trip-modification` | **v450** |
| `confirm-trip-modification-payment` | **v258** |
| `update-preauth-on-trip-modification` | **v517** (unchanged; Bug #18 Tier A) |

**Backend SHAs:** `329bdde2` (Bug #28) → `f6d07bea` (Edge coalesce paren fix) on `admin-new` `main`.

---

## Customer production OTA

**Source SHA:** `eabd662972406f7e7e70d6996cc92cf84408e97f` (`onecab-customer-native` `master`)

| Runtime | Platform | Update group | Update ID |
| --- | --- | --- | --- |
| `1.0.6(23)` | iOS | `c86a5727-8a49-4b89-9d38-66edce0d0ade` | `01a1e043-216e-77d2-8934-664fb58eb1d6` |
| `1.0.6(46)` | Android | `dfb8c37c-c55b-44d5-802d-bf9126255372` | `01a1e043-216e-7cdb-ad74-72584e5553b8` |
| `1.0.5(22)` | iOS | `d827771a-5c84-438c-84db-9e24d01fb534` | `01a1e044-539d-76cd-9372-ce2c5d6e5b61` |
| `1.0.5(45)` | Android | `2d1bfd4e-a25f-446a-b3cb-e603d19d8fa6` | `01a1e044-539d-7a43-918b-3b0e5edfa21f` |

Dashboards:
- https://expo.dev/accounts/awehliye44/projects/onecab-customer-native/updates/c86a5727-8a49-4b89-9d38-66edce0d0ade
- https://expo.dev/accounts/awehliye44/projects/onecab-customer-native/updates/dfb8c37c-c55b-44d5-802d-bf9126255372
- https://expo.dev/accounts/awehliye44/projects/onecab-customer-native/updates/d827771a-5c84-438c-84db-9e24d01fb534
- https://expo.dev/accounts/awehliye44/projects/onecab-customer-native/updates/2d1bfd4e-a25f-446a-b3cb-e603d19d8fa6

No Driver OTA. No native / store. Buffer remains disabled. Same-order increment / one capture / no supplementary payments preserved.

---

## Rollback

**Edge** — redeploy prior revisions of `request-trip-modification` / `confirm-trip-modification-payment` from commit before `329bdde2` (or dashboard function rollback).

**Customer OTA** — roll production channel to prior Bug #25 groups:

```bash
eas update:rollback --branch production --group b46db1d5-ea56-455c-b15b-1bab9c73b176   # iOS 1.0.6 Bug #25
eas update:rollback --branch production --group 5b79533e-b184-4ed1-bc97-f0e34a223c40   # Android 1.0.6 Bug #25
```

For 1.0.5 runtimes, roll back the `d827771a…` / `2d1bfd4e…` groups in the Expo dashboard to the previous 1.0.5 production updates.

---

## Your retest checklist

1. Fare-increasing stop add that fails increment → **Payment unsuccessful** (or **Payment declined** only with issuer evidence) with £ amounts; OK → original Assigned trip; draft discarded.
2. Confirm CTA shows **Authorising…** and cannot double-submit.
3. Successful paid modification → **Trip updated** + new fare; Assigned shows new route/fare.
4. Genuine slow pending → authorising copy; OK may return while reconcile continues; trip unchanged until commit.
5. Original hold intact on failure; no second order.

**Do not treat this as production acceptance until you complete the above.**
