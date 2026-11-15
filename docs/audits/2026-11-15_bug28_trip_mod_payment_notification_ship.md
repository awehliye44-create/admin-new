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

**Source SHA (latest one-popup fix):** `498e6033da457c6c295469586e4f92eff1ee922c`  
**Prior copy ship:** `eabd662` (superseded by one-popup OTA below)

### Latest OTA — one popup only (`498e603`)

| Runtime | Platform | Update group | Update ID |
| --- | --- | --- | --- |
| `1.0.6(23)` | iOS | `b088fda9-8579-464a-a1d6-96e69c83ebed` | `01a1e052-3712-7fe0-82fd-2f7b77768e5f` |
| `1.0.6(46)` | Android | `2d2ef2c9-72f2-4ea2-983f-3bd9c5b74e76` | `01a1e052-3712-7b30-8662-e06626dacf51` |
| `1.0.5(22)` | iOS | `a9f5d757-3c4a-4b42-949b-5a8ff1495124` | `01a1e053-6743-7d6a-9d78-d98c43defeba` |
| `1.0.5(45)` | Android | `2e26ec25-0fe5-4eb1-8133-9bed608903e3` | `01a1e053-6743-78b6-92af-25761cfe76f3` |

Dashboards:
- https://expo.dev/accounts/awehliye44/projects/onecab-customer-native/updates/b088fda9-8579-464a-a1d6-96e69c83ebed
- https://expo.dev/accounts/awehliye44/projects/onecab-customer-native/updates/2d2ef2c9-72f2-4ea2-983f-3bd9c5b74e76
- https://expo.dev/accounts/awehliye44/projects/onecab-customer-native/updates/a9f5d757-3c4a-4b42-949b-5a8ff1495124
- https://expo.dev/accounts/awehliye44/projects/onecab-customer-native/updates/2e26ec25-0fe5-4eb1-8133-9bed608903e3

**Follow-up fix:** live Review **Payment unsuccessful** now acks/suppresses the durable **Change not applied** notice so only one popup appears.

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
