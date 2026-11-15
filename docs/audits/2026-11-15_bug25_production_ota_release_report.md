# Bug #25 — Customer production OTA release report

**Date:** 2026-11-15  
**Status:** **SHIPPED** (Customer OTA only). Backend / Driver / native / store **unchanged**.

---

## Preflight

| Check | Result |
| --- | --- |
| Source SHA | `6af35fcee885789bd8f4c90a57354dbcf90565b7` |
| Contains #23/#24 (`194a3a5` ancestor) | **PASS** |
| Decline OK → `clearDraft` → Assigned | **PASS** |
| Reopen Edit → `beginEdit(activeTrip)` | **PASS** |
| Local draft clear does not cancel backend payment gate / recover | **PASS** (409 resume; no client `confirm-trip-modification-payment`) |
| Duplicate increment while unresolved | **PASS** (backend gate / reconcile; client discard does not POST a second increment) |
| Later authoritative apply → Assigned via restore/Realtime | **PASS** (draft not required) |
| Unknown/pending ≠ bank-decline copy | **PASS** (`confirming_updated_fare` / neutral) |
| Success path intact | **PASS** |
| Local jest locks (#25 + bank-decline + #24 tip Home) | **39 passed** |
| Prior Customer CI on `6af35fc` | https://github.com/awehliye44-create/onecab-customer-native/actions/runs/43719472725 — **success** |

---

## Customer OTA published

| Field | iOS | Android |
| --- | --- | --- |
| Source commit | `6af35fc` | `6af35fc` |
| Channel | `production` | `production` |
| Runtime | `1.0.6(23)` | `1.0.6(46)` |
| Update group | `b46db1d5-ea56-455c-b15b-1bab9c73b176` | `5b79533e-b184-4ed1-bc97-f0e34a223c40` |
| Update ID | `01a1df74-4c66-78c0-953e-1a2a25d0ae5a` | `01a1df75-4257-7845-81b6-06062bdb4308` |
| Message | release: Bug #25 trip-mod payment decline recovery (6af35fc) | same |

Dashboards:  
- iOS: https://expo.dev/accounts/awehliye44/projects/onecab-customer-native/updates/b46db1d5-ea56-455c-b15b-1bab9c73b176  
- Android: https://expo.dev/accounts/awehliye44/projects/onecab-customer-native/updates/5b79533e-b184-4ed1-bc97-f0e34a223c40  

Automatic OTA safe-apply protection preserved (no force-offline / no active-trip interrupt changes).

---

## Unchanged production pins

| Surface | Value |
| --- | --- |
| Backend tip (docs) | `718eb907` / later audit docs only |
| `stop-workflow` | **v673** |
| `submit-customer-trip-tip` | **v92** |
| `scheduled-ride-action` | v591 |
| `scheduled-dispatch` | v653 |
| `send-driver-notification` | v600 |
| Migration head | `20270225140000` |
| Driver production OTA | `9db6b5cc` (no Driver OTA this release; tip may include test-only `03a31b9`) |
| Bugs #23/#24 Customer lineage | Preserved inside `6af35fc` (ancestor `194a3a5`) |

---

## Rollback

```bash
# Customer production → prior Bug #23/#24 OTA groups
eas update:rollback --branch production --group a706001e-e5df-45b7-8287-17d76d3b357d   # iOS 194a3a5
eas update:rollback --branch production --group 808a2212-5720-4fda-a5a9-e89cbed91729   # Android 194a3a5
```

Or Expo dashboard rollback for groups `b46db1d5…` / `5b79533e…`.

No Edge / SQL / Driver rollback required.
