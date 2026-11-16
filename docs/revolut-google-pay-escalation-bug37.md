# Revolut escalation — Bug #37 Google Pay (ONECAB)

**Status:** Provider-side evidence required. Do **not** submit fabricated Google Pay tokens to production orders.

## Successful authorisations (baseline)

| Session | Created (UTC) | Revolut order prefix | Outcome |
|---|---|---|---|
| `5afefb62-d600-4fd3-9263-5c92faffb269` | 2026-11-15 15:33 | `6af9d0c6-6794` | `COMPLETED` / captured + trip |
| `5f760418-64f2-4237-96f3-25370f6290ea` | 2026-11-15 19:28 | `6afa07b6-976d` | Authorised then released |

Success billing (retrieve): UK postcode present (e.g. `MK4 4PY`), street + city.

## First subsequent failure (regression start)

| Session | Created (UTC) | Revolut order prefix | Audit |
|---|---|---|---|
| `1980723e-c788-49e2-9196-14edbbd7c40d` | 2026-11-16 13:56 | `6afb0ba8-cb65` | `GOOGLE_PAY_SUBMIT_FAILED` / opaque `pay_failed` (pre-hardened Edge) |

Device context: Play Store updated `com.onecab.customer.app` **versionCode 46** at **2026-11-16 12:40:58** (installer `com.android.vending`), ~76 minutes before first fail.

## Latest failed attempt (full billing present)

| Field | Value |
|---|---|
| Session | `67a7c729-53af-4786-9d6b-d50f99e9b5c6` |
| Order | `6afb58fd-c9ac-ac08-b38b-4dda3266ec20` |
| Correlation ID | `c0b7f813-7a5b-4da9-a73f-f1e00d3f3d1a` |
| Revolut HTTP | `400` |
| Revolut code / message | `validation` / `postcode is empty` |
| Our billing field_presence | street, city, postcode, country = true |
| Token shape | `token_is_json_object=true`, `token_len=1424`, not truncated |
| Ambiguity | Fake-token probes also return `postcode is empty` — message is **not** conclusive billing proof |

## Integration contract we follow

- Create order → use response **`token`** (not `id`) as Google Pay `gatewayMerchantId`
- `gateway`: `revolut`
- Pay-for-order: `POST /orders/{order_id}/payments` with `payment_method.type=google_pay`
- Merchant API version for pay: `2024-09-01` (same as other order ops)
- `environment.type`: `browser` (only value Revolut documents as supported)
- Billing: Wallet FULL address mapped to Revolut `billing_address` (no invented postcodes)

## Ask for Revolut

1. For order `6afb58fd-…` / request correlated to `c0b7f813-…`, was the Google Pay token decrypted successfully?
2. If decryption failed, what was the gatewayMerchantId / merchant mismatch?
3. Why does validation return `postcode is empty` when `billing_address.postcode` is present?
4. Diff sanitised accept vs reject for success order `6af9d0c6-…` vs fail `6afb58fd-…`.

## Sanitised payload differences (merchant-side)

| | Success `5afefb62` | Fail `67a7c729` |
|---|---|---|
| Amount | 500p | 500p |
| Currency | GBP | GBP |
| Billing postcode present | yes | yes (len 6, UK shape) |
| Token submitted | yes | yes (JSON object, len 1424) |
| Provider payments after submit | authorised/completed | none / rejected |

Never include raw Google Pay tokens, cryptograms, PAN, or full addresses in tickets.
