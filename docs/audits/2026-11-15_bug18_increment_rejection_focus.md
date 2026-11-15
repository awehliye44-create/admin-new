# Bug #18 — Focused investigation: why trip-mod increments are rejected

**Date:** 2026-11-15  
**Mode:** Read-only. No implementation or deployment.  
**Scope:** Provider rejection of incremental authorisation — not amount math.

---

## Direct answers

### 1. What exact decline codes did Revolut return?

**For the best-instrumented failure (MK-261108-001, card):**

| Field | Value stored by ONECAB after retrieve |
| --- | --- |
| HTTP on increment POST | Success (`post_http_ok: true`) — not a 4xx/5xx API rejection |
| `incremental_authorisations[].state` trail | `pending` → `pending` → `processing` → **`declined`** → `declined` |
| `incremental_authorisations[].reason` / `decline_reason` | **`null`** (ONECAB searched both fields) |
| `payments[].decline_reason` | **`null`** |
| Final order state | back to **`authorised`** |
| Final authorised total | **unchanged** at original 500p |
| ONECAB classification | `ADDITIONAL_AUTHORISATION_DECLINED` / `AUTHORISED_TOTAL_BELOW_TARGET` / evidence `provider_increment_declined` |

**For MK-261002-004 (card):** same pattern — `provider_increment_state: declined`, `provider_decline_reason: null`, `provider_error_code: null`.

**For the other 7 declined rows (mostly Apple Pay, plus MK-260917-010 / MK-261109-007 card):** older rows only store `reason: trip_modification_fare_increase`. They do **not** contain a Revolut issuer `decline_reason` / `reason` token.

**Conclusion:** Revolut’s network path completed and marked the increment **`declined`** (issuer-side in Revolut’s model). ONECAB **does not have** a concrete issuer code such as `insufficient_funds`, `do_not_honour`, `restricted_card`, etc., because Revolut returned **empty reason fields** on retrieve.  
No `ORDER_INCREMENTAL_AUTHORISATION_*` webhook rows were found in `processed_revolut_events` for these order IDs.

Official meaning of states: https://developer.revolut.com/docs/merchant/increment-authorisation — `declined` = declined by card issuer; check `reason`. Available reason vocabulary: https://developer.revolut.com/docs/guides/accept-payments/other-resources/errors/decline-reasons

---

### 2. Were failed payments Apple Pay, Google Pay, or direct card?

| Trip | Method | Δ (pence) | Age after original auth |
| --- | --- | --- | --- |
| MK-260916-041 | **Apple Pay** | +218, then +340 | ~43–49 min |
| MK-260917-010 | **Card** | +43 | ~2.5 min |
| MK-260919-017 | **Apple Pay** | +781 | ~1 min |
| MK-260923-002 | **Apple Pay** | +741 | ~16 min |
| MK-260923-009 | **Apple Pay** | +150 | ~29 s |
| MK-261002-004 | **Card** | +268 | ~9 min |
| MK-261108-001 | **Card** | +716 | ~15 min |
| MK-261109-007 | **Card** | +70 | ~0 s |

- **Apple Pay:** 5 of 9 declined attempts (4 distinct trips).  
- **Card:** 4 of 9.  
- **Google Pay:** **zero** trip-mod increment attempts in production (no success, no fail).

Apple Pay also has **confirmed** increments (e.g. MK-260916-027 +209, MK-260907-004 +150), so Apple Pay is not globally blocked.

Card brand / scheme (Visa vs Mastercard, debit vs credit) is **not present** in ONECAB session/trip snapshots for these rows.

---

### 3. Why did the original authorisation succeed but the increase fail?

Evidence-based explanation (not funds speculation):

1. **Original auth** is a customer-present payment that places a hold (order becomes `authorised`). That step succeeded for every declined trip — the same order later still showed `authorised` with the **original** total after the failed increment (MK-261108-001 trail).
2. **Increment** is a **second network authorisation** on that same pre-auth order. Revolut docs: Apple Pay / Google Pay increments work only **if the underlying card supports** pre-authorisation / incremental features; issuer may still decline the increase while leaving the first hold intact.
3. Observed sequence on MK-261108-001 proves the request was accepted by Revolut, sent to the network, then **issuer-declined**, after which the order returned to `authorised` at the **old** amount. That matches Revolut’s documented decline behaviour — not an ONECAB “bad request” rejection.
4. Failures include **tiny** increases (+43p, +70p). That is incompatible with a simple “customer had no money for the delta” narrative and points to **issuer / product / scheme policy soft-declines** (or opaque issuer codes Revolut did not surface).
5. Twin same-day Apple Pay cases: MK-260916-027 **succeeded** (+209 on an 800p hold); MK-260916-041 **failed** (+218 on an 800p hold). Same wallet class, similar size — difference is **issuer/network outcome**, not ONECAB payment-method routing.

**Cannot claim from ONECAB data:** which exact issuer rule fired, or that the customer’s available balance was insufficient / sufficient.

---

### 4. Is the original authorisation configured correctly to support subsequent increments?

**Yes, for the live path that matters:**

- Booking order create defaults to `capture_mode: manual` and `authorisation_type: pre_authorisation` when incremental auth is enabled (`buildCreateRevolutOrderRequestBody` — default on).  
- Revolut prerequisites for increment: authorised + pre_authorisation + manual capture.  
- On MK-261108-001 after decline: order still **`authorised`**, prior hold intact — Revolut treated the order as a valid incremental-auth order and processed an increment object to `declined` rather than rejecting with “unsupported authorisation type” / wrong capture mode (those would surface as eligibility / HTTP unsupported paths, not this trail).

So the failure mode is **issuer decline of the increment**, not “order was never set up for increments.”

---

### 5. Issuer, scheme, authentication, or merchant restriction?

| Hypothesis | Evidence |
| --- | --- |
| Issuer decline of increment | **Supported** — Revolut `increment_state=declined` with order remaining authorised |
| Specific issuer code | **Unavailable** in ONECAB (`reason`/`decline_reason` null) |
| Scheme (Visa/MC) restriction | **Unknown** — brand not stored |
| SCA / 3DS challenge required on increment | **Not evidenced** — no `CUSTOMER_ACTION_REQUIRED` / challenge fields on these declined rows; trail goes to `declined`, not action-required |
| Merchant MCC / incremental feature disabled | **Unlikely as global** — many **confirmed** increments on the same merchant; would need Revolut account confirmation for edge cases |
| Apple Pay unsupported for ONECAB | **False** — confirmed Apple Pay increments exist |
| Google Pay | **No data** |

Revolut public guidance: https://developer.revolut.com/docs/guides/merchant/operations/capture-and-settlement/advanced-authorisation/introduction — incremental auth supported for card / Apple Pay / Google Pay CNP; **not** if the underlying card does not support the feature.

---

### 6. Can the increased fare be authorised another supported way?

Options that fit Revolut + current ONECAB architecture (**recommendations only — not implemented**):

| Approach | Notes |
| --- | --- |
| **A. Keep current fail-closed + unchanged trip** | Already live. Correct when issuer declines. Bug #25 clears draft UI. |
| **B. Customer-present top-up / new checkout** | Controlled second-order fallback exists in code but is **off** for mods (`allowControlledFallback: false`). Would be a product/policy change: customer authenticates again for the shortfall or new total. |
| **C. Larger initial preauth buffer** | Fewer increments; does not fix issuer declines when fare rises beyond buffer. Policy change. |
| **D. Ask customer to retry with another card** | Only if product allows mid-trip method change without violating same-order increment rules — currently trip-mod path does **not** offer card switch (unified bank-decline lock). |
| **E. Revolut Merchant Support** | Open tickets with order IDs below and ask for issuer/network response codes that were not returned on GET. |

Highest-value next step for **codes**: Revolut support on these order IDs (prefix OK to share with Revolut under NDA/support):

- Decline with full trail: `6af03d79-157e-a88c-b718-37a3a2bfda20` (MK-261108-001)  
- Decline + tiny Δ: `6aabc7c9-121a-a1b2-b7d2-e700a8998d91` (MK-260917-010, +43p)  
- Apple Pay twin fail: `6aab2203-c9d4-a982-8ffb-02a42ceea28e` (MK-260916-041)  
- Apple Pay twin success: `6aaaddea-769c-aed9-93da-88da941eb97a` (MK-260916-027)

Live Merchant API retrieve was **not** run from this agent session (merchant secret not available in the local environment; secrets exist only in the hosted project). Support / dashboard retrieve is the practical way to obtain missing `reason` values.

---

## Comparison snapshot: historical success vs rejection

| | Successful example | Rejected example |
| --- | --- | --- |
| Trip | MK-260815-021 (first clear success) / MK-260916-027 (Apple Pay success) | MK-261108-001 (best trail) / MK-260916-041 (Apple Pay twin fail) |
| Method | card / apple_pay | card / apple_pay |
| Revolut API accept of POST | yes (confirmed coverage) | yes (`post_http_ok`) then network decline |
| Issuer reason code | not stored on success rows either | **null** on decline |
| Order after attempt | authorised at **new** total | authorised at **old** total |
| Trip outcome | mod could apply when coverage confirmed | mod payment-first blocked; original hold kept |

---

## Bottom line

The increased fare fails because **Revolut processes a same-order incremental authorisation and the card network/issuer declines that increment**, while leaving the **original** authorisation in place. ONECAB records that correctly as coverage-below-target. **Exact issuer decline codes are not present in ONECAB production records** (Revolut returned null `reason`). Failures are a mix of **Apple Pay and card**; **not Google Pay**. Original orders are configured for incremental auth. Root cause of *which* issuer rule fired cannot be closed without Revolut-side reason codes for the order IDs above.
