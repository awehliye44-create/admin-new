# Bug #18 — Revolut incremental authorisation failure audit (read-only)

**Date:** 2026-11-15  
**Scope:** Investigation only. No code, Edge, OTA, migration, or policy changes.  
**Production pins preserved:** backend `718eb907`, Customer OTA `6af35fc`, Driver OTA `9db6b5cc`, `stop-workflow` v673, tip Edge v92, migration head `20270225140000`. Bug #25 behaviour untouched.

---

## Executive verdict

1. **ONECAB amount math matches the Revolut Merchant API contract:** increment body uses **target TOTAL** in minor units (pence), not the delta. Modification required coverage is **new payable fare only** — the initial preauth buffer is **not** re-added on increment (so the brief’s £20→£23 hold / £25 fare example correctly targets **£25**, not £28).
2. **Declines are real provider “authorised total remains below target” outcomes**, often with Revolut `incremental_authorisations[].state = declined`. They are **not** explained by double-buffering, pounds/pence bugs, or posting a delta instead of a total.
3. **Issuer-specific decline codes are usually absent** in stored evidence (`provider_decline_reason` null). Revolut often returns only that the increment was declined / coverage insufficient. Therefore **“customer had sufficient funds” cannot be confirmed or refuted from ONECAB data alone**, and **ONECAB must not invent insufficient-funds**.
4. **Apple Pay fails more often than card but is not unsupported:** Apple Pay has **confirmed** successes (e.g. MK-260916-027, MK-260907-004). Card also declines (including a **+43p** attempt). Pattern is **issuer/network variability**, not a ONECAB “Apple Pay blocked” bug.
5. **Original holds stay intact** after decline; modifications that fail payment are **not applied**; completed trips that earlier declined still **captured the original payable**.
6. **Bank-decline customer copy** is gated on issuer-evidence (`classifyModificationPaymentFailure` / unified bank-decline lock). Bare `AUTHORISED_TOTAL_BELOW_TARGET` without an issuer reason maps to **neutral / hold-not-raised** copy, not “Payment declined by your bank”.

---

## 1. Path audited (payment-first)

```
Customer Review Confirm
  → Edge request-trip-modification
  → fare quote / delta (modificationRouteOrigin + tripModificationFareDelta)
  → insert trip_change_requests (payment_required when fareDelta > 0)
  → executeFareIncreaseModificationPayment
  → invokePreauthUpdateOnModification
  → Edge update-preauth-on-trip-modification
  → prepareRevolutModificationAuthorisation (revolutModTopUp.ts)
  → retrieve order → if target > provider authorised total
  → executeSameOrderIncrement (persist pending row → POST increment → confirm)
  → Revolut POST /orders/{id}/increment-authorisation  { amount: TARGET_TOTAL }
  → on confirmed coverage → advance apply; else fail closed (trip unchanged)
```

**API:** Merchant API version **`2026-04-20`** (`REVOLUT_INCREMENT_API_VERSION`).  
**Docs:**  
- https://developer.revolut.com/docs/merchant/increment-authorisation  
- https://developer.revolut.com/docs/guides/merchant/operations/capture-and-settlement/advanced-authorisation/introduction  
- https://developer.revolut.com/blog/2026-02-05-incremental-authorisation  

**Official amount rule:** `amount` = **new total authorised** (minor units), not the increment delta.  
**Official limits:** order must be `authorised` + `pre_authorisation` + `manual` capture; ≤ **10** increments; sum of increments ≤ **5×** initial; card / Apple Pay / Google Pay supported (CNPA); process sequentially; **decline leaves prior authorised amount valid**.

---

## 2. Amount / buffer policy (approved ONECAB behaviour)

| Layer | Rule (as coded) |
| --- | --- |
| Initial booking hold | `computePreauthHold(payable, SA config)` → hold = payable + buffer (SA `service_area_preauth_settings`) |
| Live SA config observed | One SA row: `enable_preauth_buffer=false`, `buffer_type=fixed`, `buffer_value=2` (historical trips still show 0 / 250 / 300 pence buffers from earlier settings or other paths) |
| Modification required total | `new_fare_pence` only (`revisedPayablePenceForModification` / `invokePreauthUpdateOnModification(…, newFarePence)`) |
| Revolut POST amount | `requiredTotalPence` = that payable = **target total** |
| Skip increment | `planSameOrderIncrement`: if provider authorised ≥ required → `not_required` |

### Brief example (£20 fare, £23 auth, £25 modified)

| Question | Answer from policy + Revolut contract |
| --- | --- |
| Target authorisation | **£25.00 (2500p)** — cover new payable |
| Incremental request body | `{ "amount": 2500 }` (total), **not** `{ "amount": 200 }` |
| Re-apply £3 buffer → £28? | **No** under current modification SSOT |
| Double buffer? | **Not in increment path** (target is payable fare) |
| Headroom | Existing £3 buffer already in the hold means increases ≤ £3 need **no** increment |

Pence/GBP: all internals are integer pence; Revolut minor units = pence for GBP. Waiting remains live-only on mod quote (`request-trip-modification` comment). Discounts/airport/waiting are folded into the payable fare before the increment target is chosen — the increment itself does not recompute them.

---

## 3. Historical inventory (`payment_session_authorisations`, source trip_modification / fare_increase_modification)

| Status | n | Notes |
| --- | --- | --- |
| `ADDITIONAL_AUTHORISATION_CONFIRMED` | 13 | Includes first clear success **MK-260815-021** |
| `ADDITIONAL_AUTHORISATION_DECLINED` | 9 | All `error_classification=AUTHORISED_TOTAL_BELOW_TARGET` |
| `ADDITIONAL_AUTHORISATION_FAILED_TERMINAL` | 2 | Early Aug 15 — `authorised_total_not_increased` (pre-lock false-terminal class, MK-260815-018 era) |
| `ADDITIONAL_AUTHORISATION_PENDING` | 2 | Processing / ambiguous class |
| Google Pay trip-mod increments | **0** | No sample |
| Currency | GBP | All |

### Confirmed vs declined by method (CONFIRMED+DECLINED only)

| Method | Confirmed | Declined | Success rate |
| --- | --- | --- | --- |
| card | 10 | 4 | ~71% |
| apple_pay | 3 | 5 | ~38% |

---

## 4. Attempt catalogue (redacted)

Order IDs truncated. No PANs, tokens, or customer PII.

### A. Early card successes / tooling era (buffer often 0)

| Trip | Result | Prev→Target (Δ) | Age | Method | Notes |
| --- | --- | --- | --- | --- | --- |
| MK-260815-017 | FAILED_TERMINAL | 495→595 (+100) | ~38s | card | Pre-hardening false-terminal class |
| MK-260815-018 | FAILED_TERMINAL | 495→695 (+200) | ~20s | card | Known MK-260815-018 class |
| MK-260815-019 | PENDING | 495→595 (+100) | ~24s | card | Ambiguous/processing |
| MK-260815-020 | PENDING | 450→650 (+200) | clock skew | card | Ambiguous |
| **MK-260815-021** | **CONFIRMED** | **450→650 (+200)** | ~minutes | **card** | **First clear historical success** |
| MK-260815-025 | CONFIRMED | 788→888 (+100) | ~160s | card | |
| MK-260815-029 | CONFIRMED | 450→716 (+266) | | card | Later session total 982 |
| MK-260816-002 | CONFIRMED ×2 | 675→1039 (+364); 1039→1615 (+576) | ~24–47m | card | Successive mods same order |
| MK-260816-004 | CONFIRMED | 788→789 (+1) | ~91m | card | Tiny successful increment |
| MK-260817-005 | CONFIRMED | 450→699 (+249) | | card | |

### B. Mixed Apple Pay / card (Sep–Nov 2026)

| Trip | Result | Prev→Target (Δ) | Buffer | Age | Method | Provider decline reason |
| --- | --- | --- | --- | --- | --- | --- |
| MK-260904-013 | CONFIRMED | 480→630 (+150) | 0 | ~6m | card | — |
| MK-260907-004 | CONFIRMED | 1108→1258 (+150) | 0 | | apple_pay | — |
| MK-260915-002 | CONFIRMED | 500→811 (+311) | null | | card | — |
| **MK-260916-027** | **CONFIRMED** | **800→1009 (+209)** | **300** | ~6m | **apple_pay** | — |
| **MK-260916-041** | **DECLINED ×2** | **800→1018 (+218)**; **800→1140 (+340)** | **300** | ~35–49m | **apple_pay** | null |
| MK-260917-010 | DECLINED | 1214→1257 (**+43**) | 300 | ~2.5m | card | null; later **captured 914** on original hold |
| MK-260919-016 | CONFIRMED | 500→600 (+100) | 0 | ~35s | card | — |
| MK-260919-017 | DECLINED | 500→1281 (+781) | 0 | ~67s | apple_pay | null; trip completed capturing **500** |
| MK-260923-002 | DECLINED | 500→1241 (+741) | 0 | ~16m | apple_pay | null |
| MK-260923-009 | DECLINED | 927→1077 (+150) | 0 | ~29s | apple_pay | null |
| MK-261002-004 | DECLINED | 750→1018 (+268) | 250 | ~9m | card | state=`declined`, reason **null** |
| MK-261108-001 | DECLINED | 500→1216 (+716) | 0 | ~15m | card | evidence=`provider_increment_declined`, reason **null**; completed capture **500** |
| MK-261109-007 | DECLINED | 500→570 (**+70**) | 0 | ~0s | card | null |

**Twin comparison (same day, Apple Pay, similar shape):**  
MK-260916-027 succeeded +209 (800→1009). MK-260916-041 failed +218 (800→1018) then +340. Same wallet class, similar deltas — **no ONECAB payload-shape difference** that explains success vs decline; difference is **provider/issuer outcome**.

---

## 5. Success vs decline — evidence-backed differences

| Factor | Evidence |
| --- | --- |
| Payload shape | Same SSOT for all: `{ amount: targetTotalPence }` |
| API version | Same `2026-04-20` |
| Amount semantics | Target total — correct vs Revolut docs |
| Double buffer | Not applied on mod path |
| Method | Apple Pay over-represented in declines but **not** exclusive; Apple Pay also succeeds |
| Card scheme / issuer | **Not stored** on sessions for these rows — cannot compare Visa vs Mastercard from DB |
| Auth age | Declines span ~0s to ~49m; successes also short and long — **not** a clean TTL explanation |
| Increment size | Failures include **+43p** and **+70p** (unlikely “insufficient funds” as a sole story) and large +700p jumps |
| Order eligibility | Declines leave prior authorised total unchanged → order remained eligible / hold live |
| Idempotency | Keyed per session+order+target; prior attempt → reconcile, not blind second POST (lock tests) |
| Manual/preauth | Booking path creates pre_authorisation + manual capture (required for increments) |

**Not supported by evidence:** systematic Revolut API misuse; systematic double-buffer; treating delta as amount; Google Pay-specific failure (no samples).

**Open (needs Revolut dashboard / support):** issuer response codes, scheme, network soft-declines, wallet token MIT/CIT flags, merchant incremental-auth enablement per acquirer.

---

## 6. Decline classification

| Observed ONECAB classification | Meaning |
| --- | --- |
| `ADDITIONAL_AUTHORISATION_DECLINED` + `AUTHORISED_TOTAL_BELOW_TARGET` | Provider did not raise authorised total to target |
| Recent metadata `provider_increment_state=declined` | Revolut incremental auth object declined |
| `provider_decline_reason` | **Almost always null** in production rows |
| `bank_declined` / issuer reason for customer copy | Only when `findBankDeclineReason` matches — **not** from bare below-target |

Mapped categories for this dataset:

| Class | Assessment |
| --- | --- |
| Issuer decline | **Plausible** when Revolut marks increment `declined`, but **issuer code missing** |
| Insufficient funds | **Not evidenced** (and contradicted by tiny Δ declines) |
| Increment unsupported | **No** — eligibility treats card/Apple Pay/Google Pay as eligible; unsupported would be different status/code |
| Authentication required | **Not** dominant in stored rows (`CUSTOMER_ACTION_REQUIRED` not the declined set) |
| Invalid payment state / expired hold | **No** for declined set — prior totals remain; later captures/releases use original hold |
| Invalid request amount | **Unlikely** — totals > previous; integer pence; matches contract |
| Merchant eligibility | **Cannot confirm from ONECAB alone** |
| Technical failure | Separate `provider_failed` / FAILED_TERMINAL paths (early Aug) |
| Duplicate/conflict | Sequential same-order attempts exist; declined rows do not show confirmed double-hold |
| Timeout/ambiguous | PENDING rows (2) — distinct from DECLINED |

**Customer messaging:** Bug #25 + unified bank-decline locks correctly require issuer evidence. Historical declines with null reasons should surface **neutral** “couldn’t raise payment hold / trip unchanged” copy, not bank-blame — unless a specific response set `bank_declined=true` with a mapped reason.

---

## 7. Original authorisation safety (failed mods)

For all `ADDITIONAL_AUTHORISATION_DECLINED` trip-mod rows checked:

- Session authorised amount after decline ≈ **previous** total (hold not raised, not wiped).
- No later confirmed increment on those declined sessions in the sample.
- Trips that completed after a declined mod (**MK-260917-010**, **MK-260919-017**, **MK-261108-001**) captured the **original** payable / hold-compatible amount.
- Cancelled trips released the **original** hold (`hold_release_state=released`) without an inflated capture.
- Payment-first gate: decline → `tripUnchanged: true`; destination/stops/route must not apply (aligned with revolut-incremental-auth + Bug #25 draft discard on Customer).

Pending/ambiguous: reconcile-only on prior target rows; no blind second POST (MK-260815-018 lock).

---

## 8. Card scheme / wallet eligibility (Revolut-documented vs ONECAB)

| Source | Statement |
| --- | --- |
| Revolut increment endpoint | Card payments; Apple Pay / Google Pay listed in incremental-auth guide/blog |
| ONECAB eligibility | `card` / `apple_pay` / `google_pay` allowed; missing type still attempts (provider is authority) |
| Production | Card + Apple Pay used; **no Google Pay** trip-mod increment samples |
| Debit vs credit / scheme | **Unknown** from DB (brand fields empty) |

**Do not assume** every card that completed initial preauth will accept increments — Revolut docs and this dataset both show issuer/network declines with prior hold intact.

---

## 9. Recommendations (analysis only — do not implement in this audit)

1. **Persist full redacted Revolut increment evidence** (increment id, state, reason, scheme, wallet type) on every attempt — today’s null reasons block issuer RCA.
2. **Revolut Merchant support ticket** with redacted order prefixes from declined rows (esp. MK-260916-041 twin vs MK-260916-027, and +43p MK-260917-010) asking for issuer/network codes.
3. **Product alternatives when increment declines** (policy decision later):  
   - Keep trip unchanged (current) + clearer “card won’t increase hold” copy when no issuer reason.  
   - Optional customer-authenticated top-up / new payment session **only** as an explicit approved fallback (today controlled fallback is off by default).  
   - Larger initial buffer to reduce increment frequency (policy change — not done here).  
   - Prefer card-on-file paths that Revolut confirms are MIT-friendly for increments, if support identifies wallet soft-declines.
4. **Do not** change Revolut increment target semantics, buffer-on-mod policy, or Bug #25 recovery without a separate approved change.
5. **Do not** treat `AUTHORISED_TOTAL_BELOW_TARGET` alone as insufficient funds or as bank-decline copy.

---

## 10. What this audit does **not** claim

- That the customer’s bank account lacked funds.
- That Revolut Merchant API is globally broken (historical successes prove otherwise).
- That Apple Pay is unsupported for ONECAB increments.
- That a code deploy is required to “fix” declines (root cause sits at **provider/issuer response**, with **insufficient issuer telemetry** in ONECAB).

---

## 11. Code-path cross-check (shared-module audit)

Independent module walkthrough confirms the same SSOT: Revolut receives **target total** pence; modification payable is **new fare only**; buffer is SA DB config (`service_area_preauth_settings`) and is **not** re-applied on increment. Live prod SA row observed in this investigation: `enable_preauth_buffer=false` (historical trips still show 0/250/300p buffers from earlier config).

**Residual engineering note (not a decline root cause):** two coverage helpers exist — `classifyIncrementCoverage` (requires provider-authoritative authorised increment state; used on the live POST/retrieve path) vs `classifyModificationApplyCoverage` (total-at-or-above-target; used in some simulate/decide helpers). Live apply still goes through `decideFromPreauthInvokeResult` + `claim_and_apply_fare_increase_modification` with `ADDITIONAL_AUTHORISATION_CONFIRMED` evidence. MK-260915-002 already locked processing increments out of “confirmed”. No change in this audit.

## 12. Artifacts / queries

Primary table: `public.payment_session_authorisations` joined to `payment_sessions` + `trips`.  
Key modules: `revolutOrders.ts`, `executeSameOrderIncrementSSOT.ts`, `revolutModTopUp.ts`, `executeFareIncreaseModificationPayment.ts`, `tripModificationPaymentGateSSOT.ts`, `preauthBuffer.ts`.

No production mutations performed. No Edge/OTA/Driver changes.
