# Revolut engineering escalation — ONECAB Bug #37 (Google Pay)

**Merchant:** ONECAB Ltd  
**Status:** Open — production Google Pay authorisations failing since 2026-11-16 ~13:56 UTC  
**Constraint:** Do **not** ask ONECAB to submit fabricated Google Pay tokens to production orders.

---

## 1. Last successful authorisations

| Field | Value |
|---|---|
| Session | `5f760418-64f2-4237-96f3-25370f6290ea` |
| Created (UTC) | **2026-11-15 19:27:50** |
| Revolut order | `6afa07b6-976d-…` (prefix) |
| Amount | 720p GBP |
| Outcome | Token submitted (`google_pay_submitted=true`); order later `CANCELLED` / session `released` (hold released after success path) |

Prior same-day success:

| Field | Value |
|---|---|
| Session | `5afefb62-d600-4fd3-9263-5c92faffb269` |
| Created (UTC) | **2026-11-15 15:33:26** |
| Revolut order | `6af9d0c6-6794-…` |
| Amount | 500p GBP |
| Outcome | `COMPLETED` / captured + trip created |
| Billing on retrieve (sanitised) | UK postcode present (shape `MK4 4PY`), street + city present |

Also: `a5ec8296-…` at 15:28 UTC same day (captured).

**No successful Google Pay submit after 2026-11-16 12:40:58 UTC** (0 / 16 attempts).

---

## 2. First failed attempt (regression start)

| Field | Value |
|---|---|
| Session | `1980723e-c788-49e2-9196-14edbbd7c40d` |
| Created (UTC) | **2026-11-16 13:56:56** |
| Revolut order | `6afb0ba8-cb65-…` |
| Amount | 763p GBP |
| Audit | `GOOGLE_PAY_SUBMIT_FAILED` message `pay_failed` (pre-hardened Edge — **opaque**; does not prove billing vs token) |
| Trip / hold | none |

Chronology on device under test:

- Play updated `com.onecab.customer.app` to **versionCode 46** at **2026-11-16 12:40:58** (`com.android.vending`).
- First fail ~76 minutes later.

---

## 3. Latest real failed attempt (structured evidence)

| Field | Value |
|---|---|
| Session | `67a7c729-53af-4786-9d6b-d50f99e9b5c6` |
| Created (UTC) | **2026-11-16 19:26:52** |
| Revolut order id | `6afb58fd-c9ac-ac08-b38b-4dda3266ec20` |
| ONECAB correlation id | `c0b7f813-7a5b-4da9-a73f-f1e00d3f3d1a` |
| Amount | 500p GBP |
| Revolut HTTP | **400** |
| Revolut body (sanitised) | `code=validation`, `message=postcode is empty` |
| Our `billing_address` field_presence | `street=true`, `city=true`, `postcode=true` (len 6, digit+letter), `country=true` |
| Token shape | `token_is_json_object=true`, `token_len=1424`, not truncated (`token_looks_truncated=false`) |
| Token fingerprint (SHA-256 prefix) | `d7ee30cea1e9acd8…` (full hash in audit; **never** raw token) |

---

## 4. Integration contract (verified against Revolut Android S2S docs)

| Step | ONECAB behaviour |
|---|---|
| Create order | Merchant API create order → use response **`token`** (public order token), **not** `id` |
| Google Pay `gateway` | `"revolut"` |
| Google Pay `gatewayMerchantId` | dynamic per payment = order **`token`** |
| Tokenisation | `PAYMENT_GATEWAY` |
| Auth methods | `PAN_ONLY` + `CRYPTOGRAM_3DS` |
| Billing collection | `billingAddressRequired=true`, format `FULL` |
| Pay-for-order | `POST /api/orders/{order_id}/payments` |
| Merchant API version (pay / orders) | **`2024-09-01`** (`Revolut-Api-Version`) |
| `payment_method.type` | `google_pay` |
| `environment.type` | `browser` (only documented value) |
| Billing | Wallet FULL mapped to Revolut `billing_address`; **no** invented postcodes |

Native `PaymentDataRequest` construction is **identical** between last EAS store binary **vc45** (`dfb5128`) and Play **vc46/vc47** release SHA `ec78af1` for gateway / tokenisation / auth methods / FULL billing. `play-services-wallet:19.4.0` unchanged. Upload signing SHA-1 `8D:3D:C7:03:…:85:44` matches.

---

## 5. Questions for Revolut

For order **`6afb58fd-c9ac-ac08-b38b-4dda3266ec20`** and ONECAB correlation **`c0b7f813-7a5b-4da9-a73f-f1e00d3f3d1a`**:

1. **Token decryption** — Did Google Pay token decrypt succeed or fail?
2. **Gateway merchant mismatch** — Did `gatewayMerchantId` in the token match the order’s public `token`?
3. **Order-token binding** — Was the token bound to a different order / expired token / wrong merchant?
4. **Merchant / Google Pay configuration** — Any merchant-side Google Pay or production-access regression between 2026-11-15 19:28Z and 2026-11-16 13:56Z?
5. **Billing validation** — Why return `postcode is empty` when request `billing_address.postcode` is present (UK shape, non-empty)?
6. **Provider regression** — Any known Google Pay / Pay-for-order validation change in that window?

Please compare sanitised accept path for success order **`6af9d0c6-6794-…`** / session `5afefb62-…` vs reject path for `6afb58fd-…`.

---

## 6. What we are **not** providing

- Raw Google Pay payment tokens / cryptograms / PAN  
- Customer full billing addresses or cardholder PII beyond field presence  
- Fabricated tokens for further production probes  

---

## 7. Contact / follow-up

ONECAB can supply additional sanitised audit rows (token SHA-256, correlation ids, HTTP status, field_presence) for any order id you nominate from the failed set after 2026-11-16 13:56Z.
