# Revolut Customer Checkout — Backend Contract (Phase 2)

Owner: platform backend. Audience: customer-app team.

Status: **LIVE** on the admin backend as of Phase 2. Historical trips created on the legacy Stripe path continue to be captured/refunded through the existing Stripe admin endpoints; new bookings run entirely on Revolut.

## Flow

```
Customer app                Admin backend                 Revolut Merchant API
    │                            │                              │
    │  POST /create-payment-intent (JWT)                        │
    │──────────────────────────►│                              │
    │                            │  POST /orders (manual)       │
    │                            │─────────────────────────────►│
    │                            │◄─────────────────────────────│
    │                            │      { id, token, checkout_url, state }
    │◄──────────────────────────│
    │      { provider: "revolut", provider_order_id,
    │        provider_checkout_token, provider_checkout_url,
    │        payable_pence, preauth_hold_pence, preauth_buffer_pence, ... }
    │                            │                              │
    │  Open RevolutCheckout widget with `provider_checkout_token`
    │─────────────────────────────────────────────────────────►│
    │                            │                              │
    │                            │◄── webhook: ORDER_AUTHORISED │
    │                            │      trips.payment_status = "authorized"
    │                            │                              │
    │                            │  (trip completes; admin or auto-capture)
    │                            │  POST /revolut-capture-order │
    │                            │─────────────────────────────►│
    │                            │◄── webhook: ORDER_COMPLETED  │
    │                            │      trips.payment_status = "captured"
```

## Endpoint: `POST /functions/v1/create-payment-intent`

**Auth:** customer JWT (rider role).

**Request body:**
```json
{
  "trip_id": "uuid",
  "estimated_fare_pence": 1250,
  "discount_amount_pence": 0,
  "payment_method_type": "card" | "apple_pay" | "google_pay"
}
```

**Response body (200):**
```json
{
  "provider": "revolut",
  "provider_order_id": "revolut-order-uuid",
  "provider_checkout_token": "short-lived token for the widget",
  "provider_checkout_url": "https://checkout.revolut.com/…",

  "payment_intent_id": "revolut-order-uuid",   // alias, do not use for new code
  "client_secret": "same as provider_checkout_token", // alias

  "status": "PENDING",
  "amount": 1300,                     // hold amount in minor units
  "currency": "gbp",
  "payable_pence": 1250,
  "preauth_hold_pence": 1300,
  "preauth_buffer_pence": 50,
  "application_fee_amount": 250       // internal commission, informational
}
```

## Widget integration

Load the Revolut Checkout SDK on the customer app and open it with the returned token:

```ts
import RevolutCheckout from "@revolut/checkout";

const rc = await RevolutCheckout(provider_checkout_token, "prod"); // "sandbox" in test
rc.payWithPopup({
  savePaymentMethodFor: "customer",
  onSuccess: () => { /* leave to webhook + polling */ },
  onError: (err) => { /* surface to user */ },
});
```

The customer app must **not** attempt to capture or refund locally. Terminal
state is authoritative from the admin backend (via webhook → `trips.payment_status`).

## Admin capture / cancel / refund

Server-only endpoints (admin JWT required):

| Endpoint | Purpose |
| --- | --- |
| `POST /functions/v1/revolut-capture-order` | Capture (partial or full) an authorised order. |
| `POST /functions/v1/revolut-cancel-order`  | Cancel an uncaptured order and release the hold. |
| `POST /functions/v1/revolut-refund-order`  | Refund (partial or full) a captured order. |

All three take `{ trip_id, reason, amount_pence? }` and write an
`admin_payment_audit` row scoped by `provider = 'revolut'`.

## Webhook: `POST /functions/v1/revolut-webhook`

Registered against Revolut Merchant API. Verifies `v1=…` HMAC-SHA256 of
`v1.{timestamp}.{rawBody}` with `REVOLUT_WEBHOOK_SECRET`, rejects
timestamps skewed more than 5 minutes.

Applied status mapping:

| Revolut state | `trips.payment_status` |
| --- | --- |
| `AUTHORISED` / `PROCESSING` | `authorized` |
| `COMPLETED` | `captured` |
| `CANCELLED` | `canceled` |
| `FAILED` | `failed` |
| `REFUNDED` | `refunded` |

Every verified event is inserted into `admin_payment_audit` with
`action = 'revolut_webhook'` for immutable history.

## Data on `trips`

New provider-scoped columns:

- `payment_provider` — `"revolut"` for new bookings.
- `provider_order_id` — Revolut order UUID.
- `provider_checkout_token` — short-lived widget token (do not persist beyond first use).
- `provider_charge_id` — populated when captured.

Historical Stripe columns (`stripe_payment_intent_id`, `stripe_charge_id`, `stripe_transfer_id`, etc.) are **frozen for legacy trips** and no longer written for new bookings. Do not dual-write.

## Driver payouts

Out of scope for Phase 2. Driver-side settlement (commission, driver
transfer, ledger writeback) continues on the existing Stripe Connect path
for historical trips and is being ported to Revolut Business `/pay` in
Phase 3. Until Phase 3 ships, captured Revolut orders leave the driver
payout obligation to accrue in the internal wallet ledger and be settled
via the existing manual payout path.
