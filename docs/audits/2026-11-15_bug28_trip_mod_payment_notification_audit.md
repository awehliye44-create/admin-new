# Bug #28 — Misleading trip modification payment notifications (read-only)

**Date:** 2026-11-15  
**Reference trip:** MK-261115-014  
**Mode:** Audit only. No implementation, Edge deploy, OTA, or bookings.

Screenshots: Review “Confirming updated fare” (~17:04) + bank “Declined payments” ONECAB LIMITED **£2.27** (~17:06).

---

## Executive verdict

1. The popup the customer saw is the **pending** state `confirming_updated_fare`, not a final bank-decline or success outcome. Copy is generic, has **no £ amounts**, and the Alert has **no loading indicator**.
2. On MK-261115-014 the increment was **authoritatively terminal** in `payment_session_authorisations` (`ADDITIONAL_AUTHORISATION_FAILED_TERMINAL`, Revolut `increment_state=failed`, Δ **227p**), but `trip_change_requests` was left as **`payment_pending` / `payment_unknown`**. That forces Customer UI to keep treating the outcome as “still confirming”.
3. Root cause of the sticky pending UI: `invokePreauthUpdateOnModification` **throws** on non-2xx from `update-preauth-on-trip-modification` without parsing the structured `error_code` body; the catch path maps that to **reconciliation pending**. A safety net only lifts pending when status is `ADDITIONAL_AUTHORISATION_DECLINED`, **not** `ADDITIONAL_AUTHORISATION_FAILED_TERMINAL`.
4. The bank app’s declined **£2.27** matches the fare delta; Revolut classified the increment as **`failed`** (technical), not `declined`, with **null** reason — so **bank-decline copy must not** be used for this trip under current locks (correct for #4). Required copy #2 applies only when issuer decline is confirmed.
5. Payment safeguards (same-order increment, original hold **671p** intact, no second order, buffer off, Bug #25 draft discard on OK) held. Trip fare stayed **£6.71**; modification was not applied.

---

## 1. Production evidence (MK-261115-014)

| Item | Value |
| --- | --- |
| Trip | `5be4f20b-…` — ended cancelled; fare/estimated **6.71**; Apple Pay |
| Change | `add_stop` (+ 26 Barnsdale Dr) |
| Quote | original **671p** → new **898p**, Δ **227p** (£2.27) |
| Revolut order | `6af9e5c7-ff57-a809-8d17-9a95c0056f5a` |
| Increment | submitted ~17:04:22Z; trail pending → processing → **`failed`** @ 17:04:23.316Z |
| PSA | `ADDITIONAL_AUTHORISATION_FAILED_TERMINAL` / `PROVIDER_INCREMENT_FAILED`; hold after = **671p** |
| Method / brand | `apple_pay` / `visa` (Tier A telemetry present) |
| TCR | status **`payment_pending`**, payment_status **`pending`**, rejection_reason **`payment_unknown`**, payment_confirmed_at null |
| Customer screenshot | Alert title **Confirming updated fare** (maps from `confirming_updated_fare`) |
| Bank screenshot | Declined **£2.27** ONECAB LIMITED |

---

## 2. Notification lifecycle today

```
Confirm Changes
  → submitTripChange → request-trip-modification
  → executeFareIncreaseModificationPayment
  → invokePreauthUpdateOnModification → update-preauth-on-trip-modification
  → executeSameOrderIncrement
  → gate + TCR update
  → HTTP response → Alert.alert(title, message, OK)
```

| Authoritative outcome | Backend gate (intended) | Client UI state | Copy today |
| --- | --- | --- | --- |
| Processing / ambiguous | `PAYMENT_PENDING` | `confirming_updated_fare` | “Confirming updated fare” / no £ / no spinner in Alert |
| Issuer decline + reason | `PAYMENT_FAILED` + bank | `payment_bank_declined` | “Payment declined by your bank” (no dynamic £) |
| Below-target / not authorised | `PAYMENT_FAILED` | `payment_declined` / `payment_unsupported` | Neutral hold-not-raised (no dynamic £) |
| Technical `PROVIDER_INCREMENT_FAILED` | **Should** be `PAYMENT_FAILED` / `payment_failed` | **Should** be `payment_not_completed` | “Trip change not completed…” |
| Applied | applied | success path → Assigned | No “Trip updated” / £X.XX success Alert today |

**MK-261115-014 path:** increment terminal `failed` → update-preauth **409** + `error_code=PROVIDER_INCREMENT_FAILED` → invoke **throws** → catch → gate `PAYMENT_PENDING` / reason `unknown` → TCR `payment_pending` + `payment_unknown` → client maps to **`confirming_updated_fare`**.

---

## 3. UX gaps vs required Bug #28 behaviour

| Required | Current |
| --- | --- |
| Pending title “Authorising additional payment” + £X.XX additional | “Confirming updated fare”; **no amounts** |
| Loading indicator; lock duplicate submits | Confirm CTA shows “Updating…” / busy; **Alert has no spinner**; OK dismissible while copy still says confirming |
| Long pending → return to original trip; reconcile continues | OK on pending already discards draft → Assigned (Bug #25); no explicit “still reconciling” framing |
| Bank decline: “Payment declined” + additional £ + original £; OK → Assigned | Bank copy exists but different wording; **no dynamic £**; OK → Assigned already (Bug #25) |
| Success: “Trip updated” + updated £ | Soft success via navigation; **no dedicated success Alert with fare** |
| Technical/unknown ≠ bank decline | Intended; **014 incorrectly stayed on pending** instead of technical failure |
| Background/resume transition pending → final | TCR left `payment_pending`; resume/poll of change request would **keep** confirming copy |

---

## 4. Root cause (exact)

**Primary (014 sticky pending):** Structured terminal failure from `update-preauth-on-trip-modification` is not applied to the payment gate because [`invokePreauthUpdateOnModification`](../../supabase/functions/_shared/tripModificationApply.ts) does not parse non-2xx JSON (except Revolut checkout), and [`executeFareIncreaseModificationPayment`](../../supabase/functions/_shared/executeFareIncreaseModificationPayment.ts) catch maps throws to reconciliation **pending**. Safety net only promotes pending → failed for **`ADDITIONAL_AUTHORISATION_DECLINED`**, not **`ADDITIONAL_AUTHORISATION_FAILED_TERMINAL`**.

**Secondary (copy / UX product gaps):** [`messageForModificationUiState`](../../../onecab-customer-native/src/features/booking/data/tripModificationUi.ts) hardcodes pending/success/decline strings without authoritative £ amounts; pending Alert is not a loading surface; success has no “Trip updated / £X.XX” notification.

**Not a root cause:** same-order increment math, buffer policy, or Bug #25 OK→Assigned discard (those behaved). Revolut `failed` vs bank “Declined £2.27” is a **provider classification vs bank UI** discrepancy — do not invent bank-decline copy without issuer evidence.

---

## 5. Recommended permanent fix (do not implement in this audit)

1. **Parse structured bodies** from failed `functions.invoke` in `invokePreauthUpdateOnModification` (same pattern as Customer `readFunctionsHttpBody`) so `PROVIDER_INCREMENT_FAILED` / decline codes reach `decideFromPreauthInvokeResult`.  
2. **Safety net:** when gate is pending, also treat `ADDITIONAL_AUTHORISATION_FAILED_TERMINAL` (+ provider_failed metadata) as terminal technical failure → `payment_failed` / technical copy.  
3. **Customer copy** (dynamic pence from TCR / payment result): pending / bank decline / success / technical as specified in Bug #28; never bank wording for `failed` / unknown.  
4. Pending UI: loading indicator + keep submit lock; after bounded wait, allow return to Assigned while reconcile continues.  
5. Preserve: original hold, same-order increment, buffer off, Bug #25, no second order / top-up.

---

## 6. What this audit does not claim

- That MK-261115-014 was a confirmed issuer decline in Revolut’s model (`increment_state=failed`).  
- That under-2s or Bug #18 issuer-reason null is solved.  
- That implementation has started.

**Bug #28 status:** OPEN — awaiting approval to implement.
