# Bug #18 Tier A — Ship report + Revolut support package

**Date:** 2026-11-15  
**Status:** Tier A **SHIPPED** (backend telemetry only). **Bug #18 remains OPEN** pending Revolut’s technical response.  
**Commit:** `2c7ecdeb`  
**Scope:** Evidence enrichment only. No buffer / second order / top-up / OTA / paid bookings.

---

## 1. Implementation

Enriched allow-listed evidence on every same-order increment attempt via:

- [`supabase/functions/_shared/revolutIncrementEvidenceSSOT.ts`](../../supabase/functions/_shared/revolutIncrementEvidenceSSOT.ts)
- [`supabase/functions/_shared/executeSameOrderIncrementSSOT.ts`](../../supabase/functions/_shared/executeSameOrderIncrementSSOT.ts)

### Captured (non-sensitive)

| Field | Source |
| --- | --- |
| `provider_order_id` | Revolut order UUID |
| `increment_request_reference` | ONECAB idempotent reference |
| `previous_authorised_total_pence` | Pre-increment authorised total |
| `requested_increment_delta_pence` | target − previous |
| `requested_target_total_pence` | POST amount (target total) |
| `payment_method_type` | `card` / `apple_pay` / `google_pay` |
| `card_brand` | scheme/brand when Revolut returns it |
| `increment_state` / `increment_reason` / `payment_decline_reason` | Provider codes (often null) |
| `post_http_ok` / `post_http_status` | HTTP outcome |
| `request_started_at` / `response_completed_at` / `increment_created_at` | Timestamps |
| `processing_outcome` | authorised / declined / failed / unsettled |
| `order_state` / `authorisation_type` / `capture_mode` | Order setup |
| `provider_authorised_total_pence` | Authorised total after attempt |
| `original_authorisation_status_after_attempt` | Post-decline hold status string |

**Never persisted:** PAN, CVV, tokens, `last_four`, ACS URLs, credentials.

Lock: `revolutIncrementEvidenceBug18Lock.test.ts`.

### Preserved (unchanged)

- Same-order target-total increment semantics  
- No second Revolut order / no release-and-reauth  
- No buffer increase / no controlled fallback top-up  
- Bug #25 decline → trip unchanged  
- Fare, commission, capture, tips, coverage rules  

---

## 2. Regression

| Suite | Result |
| --- | --- |
| `revolutIncrementEvidenceBug18Lock` | **4 PASS** |
| `revolutIncrementAuthorisationSSOT` | **7 PASS** |
| `revolutIncrementCoverage018` | **12 PASS** |
| `incrementalPaymentCertificationLock` | **3 PASS** |
| **Total** | **26 PASS** |

---

## 3. Deployed versions

| Function | Version (after Tier A) |
| --- | --- |
| `update-preauth-on-trip-modification` | **v517** (was 516) |
| `admin-increment-revolut-authorisation` | **v197** (was 196) |
| `stop-workflow` | **v675** (was 674; bundles shared increment SSOT for completion increments) |

No Customer / Driver OTA. No native / store.

---

## 4. Full redacted production evidence (support pack)

Currency GBP. No PANs / tokens / last_four.

### A. Successful comparison — MK-260916-027 (Apple Pay)

| Field | Value |
| --- | --- |
| Revolut order ID | `6aaaddea-769c-aed9-93da-88da941eb97a` |
| Method | `apple_pay` |
| Original auth | 800p @ 2026-09-16 18:20:37.589Z (buffer 300p) |
| Increment submitted | 2026-09-16 18:26:46.598Z |
| Previous → target (Δ) | 800 → **1009** (+209) |
| Outcome | `ADDITIONAL_AUTHORISATION_CONFIRMED` |
| Provider confirmed | 1009p |
| Operation reference | `revolut_increment:6dcb8903-a91f-4668-98b7-b3ef27a838a1:6aaaddea-769c-aed9-93da-88da941eb97a:1009` |
| Session later | released (trip cancelled path); provider_state `CANCELLED` |

### B. Twin decline — MK-260916-041 (Apple Pay)

| Field | Value |
| --- | --- |
| Revolut order ID | `6aab2203-c9d4-a982-8ffb-02a42ceea28e` |
| Method | `apple_pay` |
| Original auth | 800p @ 2026-09-16 23:11:09.749Z (buffer 300p) |
| Attempt 1 | submitted 23:54:15.804Z → target **1018** (+218) → `ADDITIONAL_AUTHORISATION_DECLINED` / `AUTHORISED_TOTAL_BELOW_TARGET` @ 23:54:17.263Z |
| Attempt 2 | submitted 23:59:42.328Z → target **1140** (+340) → declined @ 23:59:43.767Z |
| Issuer reason in ONECAB | **null** (older rows; thin metadata) |
| Session later | released; provider_state `CANCELLED` |

### C. Tiny Δ decline — MK-260917-010 (card)

| Field | Value |
| --- | --- |
| Revolut order ID | `6aabc7c9-121a-a1b2-b7d2-e700a8998d91` |
| Method | `card` |
| Original auth | 1214p @ 2026-09-17 11:00:13.961Z (buffer 300p) |
| Increment | submitted 11:02:46.509Z → target **1257** (+**43**) → declined @ 11:02:47.716Z |
| Classification | `AUTHORISED_TOTAL_BELOW_TARGET` |
| After decline | Original hold intact; trip **captured 914p** @ 11:14:48.814Z (final fare ≤ original hold) |
| Issuer reason | **null** |

### D. Best-instrumented decline — MK-261108-001 (card)

| Field | Value |
| --- | --- |
| Revolut order ID | `6af03d79-157e-a88c-b718-37a3a2bfda20` |
| Method | `card` |
| Original auth | 500p @ 2026-11-08 09:14:41.437Z (buffer 0) |
| Increment | submitted 09:30:08.637Z → target **1216** (+716) |
| HTTP | `post_http_ok: true` (not an API 4xx rejection) |
| Trail | pending → pending → processing → **declined** → declined |
| Final evidence | `increment_state=declined`, `increment_reason=null`, `payment_decline_reason=null`, `order_state=authorised`, `provider_authorised_total_pence=500` |
| Classification | `ADDITIONAL_AUTHORISATION_DECLINED` / `AUTHORISED_TOTAL_BELOW_TARGET` / evidence `provider_increment_declined` |
| After decline | Hold **500p** still authorised; trip **captured 500p** @ 09:31:16.163Z |

Evidence trail timestamps (UTC):

1. 09:30:09.151Z post_response — increment `pending`, order `authorised`, auth total 500  
2. 09:30:09.205Z retrieve — `pending`, order `processing`  
3. 09:30:09.613Z retrieve — `processing`  
4. 09:30:10.025Z retrieve — `declined`, order still `processing`  
5. 09:30:10.430Z retrieve — `declined`, order back to `authorised`, auth total **500**

### E. Fresh Apple Pay incident — MK-261115-014 (Tier A live)

Full investigation: [`2026-11-15_bug18_mk261115014_fresh_incident.md`](./2026-11-15_bug18_mk261115014_fresh_incident.md)

| Field | Value |
| --- | --- |
| Revolut order ID | `6af9e5c7-ff57-a809-8d17-9a95c0056f5a` |
| Method / brand | `apple_pay` / `visa` |
| Original auth | **671p** @ 2026-11-15 17:03:15.077Z (**buffer 0**) |
| Increment | submitted 17:04:22.109Z → target **898** (+**227**) |
| HTTP | `post_http_ok: true` |
| Trail | pending → pending → processing → **failed** (946 ms) |
| Final evidence | `increment_state=failed`, `increment_reason=null`, `payment_decline_reason=null`, `order_state=authorised`, `provider_authorised_total_pence=671` |
| Classification | `ADDITIONAL_AUTHORISATION_FAILED_TERMINAL` / `PROVIDER_INCREMENT_FAILED` |
| After attempt | Hold **671p** intact; stop/fare **not** applied; session later released 671 on cancel |
| Customer bank | Declined payments ONECAB LIMITED **£2.27** (~17:06) — exact delta; funds available |
| Customer app | “Confirming updated fare” (TCR left `payment_pending` — Bug #28) |
| Tier A | **Live** — method, brand, trail, delta/target persisted |

Evidence trail timestamps (UTC):

1. 17:04:22.452Z post_response — increment `pending`, order `authorised`, auth total 671  
2. 17:04:22.503Z retrieve — `pending`, order `processing`  
3. 17:04:22.913Z retrieve — `processing`  
4. 17:04:23.316Z retrieve — **`failed`**, order back to `authorised`, auth total **671**

---

## 5. Draft Revolut Merchant Support message (for your review)

**Subject:** Incremental authorisation declined with null issuer reason — request network/issuer codes + same-order increase guidance

Hello Revolut Merchant Support,

We are ONECAB (Merchant API version **2026-04-20**). We use **manual capture** + **`authorisation_type=pre_authorisation`** so trip modifications can raise the hold via:

`POST /orders/{order_id}/increment-authorisation` with `{ "amount": <new total authorised, minor units> }`  
(not the delta).

On several live GBP orders the increment is **accepted by the API** (`2xx`, increment object created), moves `pending` → `processing` → **`declined` or `failed`**, while the order returns to **`authorised`** at the **original** total. On retrieve, both `incremental_authorisations[].reason` and `payments[].decline_reason` are **`null`**, so we cannot map an issuer code for the customer or for our risk ops.

**Fresh evidence (15 Nov 2026):** on order `6af9e5c7-ff57-a809-8d17-9a95c0056f5a` (Apple Pay / Visa), Merchant retrieve reported `increment_state=failed` with null reasons in **~1s**, while the **cardholder’s bank app** listed a **Declined** payment from ONECAB LIMITED for exactly the increment delta (**£2.27 / 227p**), with sufficient funds available. That customer-side bank record is direct evidence the increase reached the banking system.

### Please advise

1. Why can an increment be **declined / failed by the issuer/network** while the **original** authorisation remains valid?  
2. Why are issuer **decline/failure reasons returned as null** on these retrieves / increment objects?  
3. Can you provide the **underlying issuer or scheme/network decline codes** for the order IDs below (from your logs)?  
4. For **MK-261115-014** specifically: why does Merchant show `failed` + null reason while the cardholder bank shows a **declined £2.27**? Please return the issuer/network code for that increment.  
5. For a future product option: can the **cardholder authenticate an increased amount on the same existing order** (challenge / CIT) **without releasing** the original hold?  
6. If that authenticated increase succeeds, can settlement still be **one final capture** of the final fare on that **same order**, with **one** Merchant transaction fee (not a second order)?

### Orders (full IDs)

| Role | Trip | Order ID | Method | Original auth (pence) | Target (pence) | Δ | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Success twin | MK-260916-027 | `6aaaddea-769c-aed9-93da-88da941eb97a` | Apple Pay | 800 @ 2026-09-16T18:20:37Z | 1009 @ 18:26:46Z | +209 | Confirmed |
| Decline twin | MK-260916-041 | `6aab2203-c9d4-a982-8ffb-02a42ceea28e` | Apple Pay | 800 @ 2026-09-16T23:11:09Z | 1018 then 1140 | +218 / +340 | Declined (reason null) |
| Tiny Δ | MK-260917-010 | `6aabc7c9-121a-a1b2-b7d2-e700a8998d91` | Card | 1214 @ 2026-09-17T11:00:13Z | 1257 @ 11:02:46Z | +43 | Declined (reason null); later captured 914 on original hold |
| Best trail | MK-261108-001 | `6af03d79-157e-a88c-b718-37a3a2bfda20` | Card | 500 @ 2026-11-08T09:14:41Z | 1216 @ 09:30:08Z | +716 | Declined (reason null); order remained authorised at 500; captured 500 |
| Fresh Apple Pay + bank Declined £2.27 | MK-261115-014 | `6af9e5c7-ff57-a809-8d17-9a95c0056f5a` | Apple Pay / Visa | 671 @ 2026-11-15T17:03:15Z (buffer 0) | 898 @ 17:04:22Z | +227 | Merchant `failed` (~0.95s), reasons null; order authorised @ 671; cardholder bank Declined £2.27 |

For **MK-261108-001** we observed: HTTP OK on increment POST; states pending → processing → declined; final order `authorised` with authorised total **unchanged at 500**; `reason` / `decline_reason` null on retrieve.

For **MK-261115-014** we observed: HTTP OK on increment POST; states pending → processing → **failed** in **946 ms**; final order `authorised` at **671**; Tier A telemetry captured `apple_pay` / `visa`; `reason` / `decline_reason` null; cardholder bank independently showed Declined **£2.27**.

We are **not** asking you to reverse these historical outcomes. We need issuer/network codes and product guidance on same-order authenticated increases vs a second payment.

Thank you,  
ONECAB Payments

---

## 6. Open / hold

| Item | Status |
| --- | --- |
| Bug #18 root cause (which issuer rule) | **OPEN** — awaiting Revolut |
| Tier B customer copy polish | **HOLD** |
| Tier C buffer / authenticated top-up | **HOLD** — do not implement until Revolut confirms Q4/Q5 |
| Customer / Driver OTA | **Not required** for Tier A |

### Rollback

Redeploy prior revisions of `update-preauth-on-trip-modification` (v516), `admin-increment-revolut-authorisation` (v196), `stop-workflow` (v674) from commit before `2c7ecdeb`.
